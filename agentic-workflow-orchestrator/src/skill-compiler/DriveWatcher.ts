import { google } from "googleapis";
import { v4 as uuidv4 } from "uuid";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { SkillCompiler } from "./SkillCompiler";
import { getGoogleAuthClient } from "../lib/google-auth";

// ─────────────────────────────────────────────────────────────
// DriveWatcher — handles incoming Google Drive push notifications.
//
// On boot, call watchFolder(folderId, webhookBaseUrl) to list all
// skill files in the folder, compile each, and register push channels.
// Channel registrations are persisted to disk so restarts don't
// create duplicate channels.
// ─────────────────────────────────────────────────────────────

export type DriveNotificationHeaders = {
  "x-goog-channel-id"?: string;
  "x-goog-resource-id"?: string;
  "x-goog-resource-state"?: string;
  "x-goog-message-number"?: string;
};

type ChannelRecord = {
  channelId: string;
  resourceId: string;
  fileId: string;
  fileName: string;
  expiration: number; // ms epoch
  webhookBaseUrl: string;
};

// How long to wait after the last notification before triggering a compile.
// Drive sends 5-15 rapid notifications per save — this collapses them into one.
const DEBOUNCE_MS = 5000;

export class DriveWatcher {
  private readonly _compiler: SkillCompiler;
  private readonly _channelFile: string;

  // Maps Drive resource ID → file ID
  private readonly _watchedResources = new Map<string, string>();
  // Per-file debounce timers
  private readonly _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(compiler: SkillCompiler, storageDir = "./.workflow-store") {
    this._compiler = compiler;
    this._channelFile = join(storageDir, "_drive_channels.json");
  }

  async watchFolder(folderId: string, webhookBaseUrl: string): Promise<void> {
    const drive = google.drive({ version: "v3", auth: getGoogleAuthClient() });

    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and (mimeType = 'text/plain' or mimeType = 'text/markdown' or mimeType = 'application/vnd.google-apps.document')`,
      fields: "files(id, name, mimeType)",
    });

    const files = res.data.files ?? [];
    if (files.length === 0) {
      console.log(`[DriveWatcher] No skill files found in folder "${folderId}"`);
      return;
    }

    console.log(`[DriveWatcher] Found ${files.length} skill file(s) in folder "${folderId}"`);

    const existingChannels = this._loadChannels();
    const now = Date.now();

    let failed = 0;
    for (const f of files.filter((f) => f.id && f.name)) {
      const existing = existingChannels.find(
        (c) => c.fileId === f.id && c.expiration > now && c.webhookBaseUrl === webhookBaseUrl
      );
      try {
        await this._watchAndCompile(f.id!, f.name!, webhookBaseUrl, existing);
      } catch (err) {
        console.error(`[DriveWatcher] Failed to watch/compile "${f.name}":`, err);
        failed++;
      }
    }
    if (failed > 0)
      console.warn(`[DriveWatcher] ${failed}/${files.length} file(s) failed to watch/compile`);
  }

  private async _watchAndCompile(
    fileId: string,
    fileName: string,
    webhookBaseUrl: string,
    existingChannel?: ChannelRecord
  ): Promise<void> {
    const drive = google.drive({ version: "v3", auth: getGoogleAuthClient() });

    if (existingChannel) {
      // Reuse existing channel — just re-register in memory
      this._watchedResources.set(existingChannel.resourceId, fileId);
      console.log(`[DriveWatcher] Reusing existing channel for "${fileName}"`);
    } else {
      // Register a new push channel
      const channelId = uuidv4();
      const watchRes = await drive.files.watch({
        fileId,
        requestBody: {
          id: channelId,
          type: "web_hook",
          address: `${webhookBaseUrl}/webhooks/drive`,
        },
      });

      const resourceId = watchRes.data.resourceId;
      const expiration = Number(watchRes.data.expiration ?? Date.now() + 7 * 24 * 60 * 60 * 1000);

      if (!resourceId) {
        console.warn(`[DriveWatcher] No resourceId for "${fileName}" — won't watch for changes`);
      } else {
        this._watchedResources.set(resourceId, fileId);
        this._saveChannel({ channelId, resourceId, fileId, fileName, expiration, webhookBaseUrl });
        console.log(`[DriveWatcher] Registered new channel for "${fileName}"`);
      }
    }

    const content = await this._fetchFileContent(fileId);
    await this._compiler.compile(content, fileId);
    console.log(`[DriveWatcher] Compiled "${fileName}"`);
  }

  async handleNotification(headers: DriveNotificationHeaders): Promise<void> {
    const resourceId = headers["x-goog-resource-id"];
    const resourceState = headers["x-goog-resource-state"];

    if (!resourceId) {
      console.warn("[DriveWatcher] Notification missing x-goog-resource-id — ignoring");
      return;
    }

    if (resourceState === "sync") {
      console.log("[DriveWatcher] Received Drive sync handshake — ignoring");
      return;
    }

    // Only recompile on actual file updates, not metadata-only changes
    if (resourceState !== "update" && resourceState !== "change") {
      console.log(`[DriveWatcher] Ignoring notification state "${resourceState}"`);
      return;
    }

    const fileId = this._watchedResources.get(resourceId);
    if (!fileId) {
      console.warn(`[DriveWatcher] Unknown resource ID "${resourceId}" — ignoring`);
      return;
    }

    // Debounce — cancel any pending compile for this file and restart the timer
    const existing = this._debounceTimers.get(fileId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this._debounceTimers.delete(fileId);
      console.log(`[DriveWatcher] Change detected for file "${fileId}" — compiling`);
      try {
        const content = await this._fetchFileContent(fileId);
        await this._compiler.compile(content, fileId);
      } catch (err) {
        console.error(`[DriveWatcher] Failed to compile file "${fileId}":`, err);
      }
    }, DEBOUNCE_MS);

    this._debounceTimers.set(fileId, timer);
  }

  // ── Channel persistence ───────────────────────────────────

  private _loadChannels(): ChannelRecord[] {
    if (!existsSync(this._channelFile)) return [];
    try {
      return JSON.parse(readFileSync(this._channelFile, "utf-8")) as ChannelRecord[];
    } catch {
      return [];
    }
  }

  private _saveChannel(channel: ChannelRecord): void {
    const channels = this._loadChannels().filter((c) => c.fileId !== channel.fileId);
    channels.push(channel);
    writeFileSync(this._channelFile, JSON.stringify(channels, null, 2), "utf-8");
  }

  // ── File content fetching ─────────────────────────────────

  private async _fetchFileContent(fileId: string): Promise<string> {
    const drive = google.drive({ version: "v3", auth: getGoogleAuthClient() });

    const meta = await drive.files.get({ fileId, fields: "mimeType,name" });
    const mimeType = meta.data.mimeType ?? "";

    if (mimeType.startsWith("application/vnd.google-apps")) {
      const res = await drive.files.export(
        { fileId, mimeType: "text/plain" },
        { responseType: "text" }
      );
      return res.data as string;
    }

    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "text" }
    );
    return res.data as string;
  }
}

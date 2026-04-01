import { google } from "googleapis";
import type { SkillCompiler } from "./SkillCompiler";
import { getGoogleAuthClient } from "../lib/google-auth";

// ─────────────────────────────────────────────────────────────
// DriveWatcher — handles incoming Google Drive push notifications.
//
// When Drive detects a change to a watched file, it sends a POST
// to /webhooks/drive. This class validates the notification,
// fetches the updated file content via the Drive API, and hands
// it off to SkillCompiler.
// ─────────────────────────────────────────────────────────────

export type DriveNotificationHeaders = {
  "x-goog-channel-id"?: string;
  "x-goog-resource-id"?: string;
  "x-goog-resource-state"?: string;
  "x-goog-message-number"?: string;
};

export class DriveWatcher {
  private readonly _compiler: SkillCompiler;

  // Maps Drive resource ID → file ID
  private readonly _watchedResources = new Map<string, string>();

  constructor(compiler: SkillCompiler) {
    this._compiler = compiler;
  }

  // Register a Drive file to watch.
  // resourceId comes from the Drive watch channel setup response.
  registerFile(resourceId: string, fileId: string): void {
    this._watchedResources.set(resourceId, fileId);
    console.log(`[DriveWatcher] Watching resource "${resourceId}" → file "${fileId}"`);
  }

  async handleNotification(headers: DriveNotificationHeaders): Promise<void> {
    const resourceId = headers["x-goog-resource-id"];
    const resourceState = headers["x-goog-resource-state"];

    if (!resourceId) {
      console.warn("[DriveWatcher] Notification missing x-goog-resource-id — ignoring");
      return;
    }

    // "sync" is Drive's initial handshake — not a real change
    if (resourceState === "sync") {
      console.log("[DriveWatcher] Received Drive sync handshake — ignoring");
      return;
    }

    const fileId = this._watchedResources.get(resourceId);
    if (!fileId) {
      console.warn(`[DriveWatcher] Unknown resource ID "${resourceId}" — ignoring`);
      return;
    }

    console.log(`[DriveWatcher] Change detected for file "${fileId}" — compiling`);

    const content = await this._fetchFileContent(fileId);
    await this._compiler.compile(content);
  }

  private async _fetchFileContent(fileId: string): Promise<string> {
    const drive = google.drive({ version: "v3", auth: getGoogleAuthClient() });

    // Get MIME type to decide how to export
    const meta = await drive.files.get({
      fileId,
      fields: "mimeType,name",
    });

    const mimeType = meta.data.mimeType ?? "";

    if (mimeType.startsWith("application/vnd.google-apps")) {
      // Google Docs/Sheets etc — export as plain text
      const res = await drive.files.export(
        { fileId, mimeType: "text/plain" },
        { responseType: "text" }
      );
      return res.data as string;
    }

    // Plain text / markdown files — download directly
    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "text" }
    );
    return res.data as string;
  }
}

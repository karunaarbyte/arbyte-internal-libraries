import { google } from "googleapis";
import type { IState } from "fsm-orchestrator";
import { ToolAction } from "../base";
import type { IToolExecutionResult } from "../../types";
import { getGoogleAuthClient } from "../../lib/google-auth";

// ─────────────────────────────────────────────────────────────
// Google Drive Tools — real Drive API implementations.
//
// Auth: OAuth2 via getGoogleAuthClient() (shared with Gmail).
// ─────────────────────────────────────────────────────────────

const getDrive = () => google.drive({ version: "v3", auth: getGoogleAuthClient() });

// ── DriveReadFileAction ───────────────────────────────────────

export class DriveReadFileAction extends ToolAction {
  readonly key = "drive.read_file";
  readonly description =
    "Read the text content of a file from Google Drive. Requires: file_id (Google Drive file ID). Returns file name and full text content.";

  async execute(
    args: Record<string, unknown>,
    state: IState
  ): Promise<IToolExecutionResult> {
    const fileId = (args.file_id ?? state.data.file_id) as string;

    if (!fileId) {
      return { success: false, message: "Missing required arg: file_id", cost: 0 };
    }

    const drive = getDrive();

    // Get file metadata to determine MIME type
    const meta = await drive.files.get({
      fileId,
      fields: "id,name,mimeType,modifiedTime",
    });

    const mimeType = meta.data.mimeType ?? "";
    let content = "";

    if (mimeType.startsWith("application/vnd.google-apps")) {
      // Google Workspace files — export as plain text
      const exportRes = await drive.files.export(
        { fileId, mimeType: "text/plain" },
        { responseType: "text" }
      );
      content = exportRes.data as string;
    } else {
      // Binary/text files — download directly
      const dlRes = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "text" }
      );
      content = dlRes.data as string;
    }

    return {
      success: true,
      message: "File read successfully",
      data: {
        file_id: fileId,
        file_name: meta.data.name ?? "",
        mime_type: mimeType,
        content,
        modified_at: meta.data.modifiedTime ?? "",
      },
      emitEventKey: "drive.file_read",
      cost: 2,
    };
  }
}

// ── DriveWriteFileAction ──────────────────────────────────────

export class DriveWriteFileAction extends ToolAction {
  readonly key = "drive.write_file";
  readonly description =
    "Write or overwrite a file in Google Drive. Requires: file_id (to update existing) OR folder_id + file_name (to create new), and content (text to write).";

  async execute(
    args: Record<string, unknown>,
    _state: IState
  ): Promise<IToolExecutionResult> {
    const content = args.content as string;
    if (!content) {
      return { success: false, message: "Missing required arg: content", cost: 0 };
    }

    const drive = getDrive();
    const { Readable } = await import("stream");
    const body = Readable.from([content]);

    if (args.file_id) {
      // Update existing file
      const res = await drive.files.update({
        fileId: args.file_id as string,
        media: { mimeType: "text/plain", body },
        fields: "id,name,modifiedTime",
      });

      return {
        success: true,
        message: "File updated successfully",
        data: {
          file_id: res.data.id ?? "",
          file_name: res.data.name ?? "",
          modified_at: res.data.modifiedTime ?? new Date().toISOString(),
        },
        emitEventKey: "drive.file_written",
        cost: 2,
      };
    }

    if (!args.folder_id || !args.file_name) {
      return {
        success: false,
        message: "Missing required args: either file_id OR (folder_id + file_name)",
        cost: 0,
      };
    }

    // Create new file
    const res = await drive.files.create({
      requestBody: {
        name: args.file_name as string,
        parents: [args.folder_id as string],
      },
      media: { mimeType: "text/plain", body },
      fields: "id,name,modifiedTime",
    });

    return {
      success: true,
      message: "File created successfully",
      data: {
        file_id: res.data.id ?? "",
        file_name: res.data.name ?? "",
        modified_at: res.data.modifiedTime ?? new Date().toISOString(),
      },
      emitEventKey: "drive.file_written",
      cost: 2,
    };
  }
}

// ── DriveListFilesAction ──────────────────────────────────────

export class DriveListFilesAction extends ToolAction {
  readonly key = "drive.list_files";
  readonly description =
    "List files in a Google Drive folder. Requires: folder_id. Returns file names and IDs.";

  async execute(
    args: Record<string, unknown>,
    state: IState
  ): Promise<IToolExecutionResult> {
    const folderId = (args.folder_id ?? state.data.folder_id) as string;

    if (!folderId) {
      return { success: false, message: "Missing required arg: folder_id", cost: 0 };
    }

    const drive = getDrive();
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "files(id,name,mimeType,modifiedTime)",
      orderBy: "modifiedTime desc",
    });

    const files = (res.data.files ?? []).map((f) => ({
      file_id: f.id ?? "",
      file_name: f.name ?? "",
      mime_type: f.mimeType ?? "",
      modified_at: f.modifiedTime ?? "",
    }));

    return {
      success: true,
      message: "Files listed successfully",
      data: { folder_id: folderId, files },
      emitEventKey: "drive.files_listed",
      cost: 1,
    };
  }
}

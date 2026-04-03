import { google } from "googleapis";
import type { IState } from "fsm-orchestrator";
import { ToolAction, fromState } from "../base";
import type { ArgDef, IToolExecutionResult } from "../../types";
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
    "Read the full text content of a Google Drive file by its file ID. " +
    "Requires: file_id (the Google Drive file ID, e.g. '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms'). " +
    "Supports Google Docs (exported as plain text) and plain text files. " +
    "Returns: file_id, file_name, mime_type, content (full text), modified_at.";

  override readonly inputSchema: ArgDef[] = [
    {
      name: "file_id",
      description: "Google Drive file ID. Read from state.data.file_id or extract from a Drive URL (the segment after /d/ and before /view or /edit).",
      source: "llm",
      required: true,
    },
  ];

  override readonly outputFields = ["file_id", "file_name", "mime_type", "content", "modified_at"];

  async execute(
    args: Record<string, unknown>,
    state: IState
  ): Promise<IToolExecutionResult> {
    const fileId = (args.file_id ?? state.data.file_id) as string;

    if (!fileId) {
      return { success: false, message: "Missing required arg: file_id", failureKind: "arg_error" };
    }

    const drive = getDrive();

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
    "Write a text file to Google Drive. Two modes: " +
    "(1) Create new file: requires content, file_name, and folder_id (from step params or DRIVE_TARGET_FOLDER_ID env var). " +
    "(2) Update existing file: requires content and file_id (to overwrite an existing file). " +
    "Read content from state.data using the key where the draft was stored. " +
    "folder_id and file_name are set at compile time in step params — do not generate them. " +
    "Returns: file_id, file_name, drive_link (shareable URL), modified_at.";

  override readonly inputSchema: ArgDef[] = [
    {
      name: "content",
      description: "Text content to write to the file. Read from state.data — check summary, report_body, draft_body, draft in that order. Do not generate or truncate.",
      source: "state",
      required: true,
      stateKeys: ["summary", "report_body", "draft_body", "draft"],
    },
    {
      name: "file_name",
      description: "Name for the new file (e.g. 'summary.txt'). Provided at compile time in step params. Do not generate.",
      source: "params",
      required: false,
    },
    {
      name: "folder_id",
      description: "Google Drive folder ID where the file will be created. Provided at compile time in step params or DRIVE_TARGET_FOLDER_ID env var. Do not generate.",
      source: "params",
      required: false,
    },
    {
      name: "file_id",
      description: "Google Drive file ID of an existing file to update. Provide only when updating an existing file — omit for new file creation.",
      source: "params",
      required: false,
    },
  ];

  override readonly outputFields = ["file_id", "file_name", "drive_link", "modified_at"];

  async execute(
    args: Record<string, unknown>,
    state: IState
  ): Promise<IToolExecutionResult> {
    // Prefer state (full, untruncated) over LLM-provided arg for content fields
    const content = fromState(state, ["summary", "report_body", "draft_body", "draft"], args.content);
    if (!content) {
      return { success: false, message: "Missing required arg: content", failureKind: "arg_error" };
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

      const fileId = res.data.id ?? "";
      return {
        success: true,
        message: "File updated successfully",
        data: {
          file_id: fileId,
          file_name: res.data.name ?? "",
          drive_link: `https://drive.google.com/file/d/${fileId}/view`,
          modified_at: res.data.modifiedTime ?? new Date().toISOString(),
        },
        emitEventKey: "drive.file_written",
        cost: 2,
      };
    }

    const folderId = (args.folder_id as string | undefined) ?? process.env.DRIVE_TARGET_FOLDER_ID;
    if (!folderId || !args.file_name) {
      return {
        success: false,
        message: "Missing required args: file_name and either folder_id arg or DRIVE_TARGET_FOLDER_ID env var",
        failureKind: "arg_error",
      };
    }

    // Create new file
    const res = await drive.files.create({
      requestBody: {
        name: args.file_name as string,
        parents: [folderId],
      },
      media: { mimeType: "text/plain", body },
      fields: "id,name,modifiedTime",
    });

    const fileId = res.data.id ?? "";
    return {
      success: true,
      message: "File created successfully",
      data: {
        file_id: fileId,
        file_name: res.data.name ?? "",
        drive_link: `https://drive.google.com/file/d/${fileId}/view`,
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
    "List files in a Google Drive folder. " +
    "Requires: folder_id (Google Drive folder ID). " +
    "Returns up to 20 files ordered by most recently modified, with file_id, file_name, mime_type, modified_at.";

  override readonly inputSchema: ArgDef[] = [
    {
      name: "folder_id",
      description: "Google Drive folder ID. Read from state.data.folder_id or provided at compile time in step params.",
      source: "llm",
      required: true,
    },
  ];

  override readonly outputFields = ["folder_id", "files"];

  async execute(
    args: Record<string, unknown>,
    state: IState
  ): Promise<IToolExecutionResult> {
    const folderId = (args.folder_id ?? state.data.folder_id) as string;

    if (!folderId) {
      return { success: false, message: "Missing required arg: folder_id", failureKind: "arg_error" };
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

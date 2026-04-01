import { google } from "googleapis";
import type { IState } from "fsm-orchestrator";
import { ToolAction } from "../base";
import type { IToolExecutionResult } from "../../types";
import { getGoogleAuthClient } from "../../lib/google-auth";

// ─────────────────────────────────────────────────────────────
// Gmail Tools — real Gmail API implementations.
//
// Auth: OAuth2 via getGoogleAuthClient() (refresh token flow).
// All calls operate on behalf of the authenticated user's inbox.
// ─────────────────────────────────────────────────────────────

const getGmail = () => google.gmail({ version: "v1", auth: getGoogleAuthClient() });

// ── Helpers ───────────────────────────────────────────────────

const decodeBase64 = (data: string): string =>
  Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");

const encodeBase64 = (data: string): string =>
  Buffer.from(data).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const buildRawEmail = (to: string, subject: string, body: string, from?: string): string => {
  const lines = [
    from ? `From: ${from}` : "",
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].filter(Boolean);
  return encodeBase64(lines.join("\r\n"));
};

const buildRawReply = (
  to: string,
  subject: string,
  body: string,
  threadId: string,
  inReplyTo: string
): string => {
  const lines = [
    `To: ${to}`,
    `Subject: Re: ${subject}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${inReplyTo}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ];
  return encodeBase64(lines.join("\r\n"));
};

const extractHeader = (
  headers: { name?: string | null; value?: string | null }[],
  name: string
): string =>
  headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

// ── GmailReadAction ───────────────────────────────────────────

export class GmailReadAction extends ToolAction {
  readonly key = "gmail.read";
  readonly description =
    "Read the most recent unread email from the Gmail inbox. Returns sender, subject, body, and message ID.";

  async execute(
    args: Record<string, unknown>,
    state: IState
  ): Promise<IToolExecutionResult> {
    const gmail = getGmail();

    // If a history_id is in state (from Pub/Sub notification), use it to
    // fetch only new messages. Otherwise fall back to latest unread.
    const historyId = (state.data.history_id ?? args.history_id) as string | undefined;

    let messageId: string | undefined;

    if (historyId) {
      const historyRes = await gmail.users.history.list({
        userId: "me",
        startHistoryId: historyId,
        historyTypes: ["messageAdded"],
      });
      const messages = historyRes.data.history?.flatMap(
        (h) => h.messagesAdded?.map((m) => m.message?.id) ?? []
      ) ?? [];
      messageId = messages[0] ?? undefined;
    }

    if (!messageId) {
      // Fallback: get latest unread
      const listRes = await gmail.users.messages.list({
        userId: "me",
        q: "is:unread",
        maxResults: 1,
      });
      messageId = listRes.data.messages?.[0]?.id ?? undefined;
    }

    if (!messageId) {
      return { success: false, message: "No unread messages found", cost: 1 };
    }

    const msgRes = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const headers = msgRes.data.payload?.headers ?? [];
    const from = extractHeader(headers, "from");
    const subject = extractHeader(headers, "subject");
    const date = extractHeader(headers, "date");

    // Extract body — check parts for text/plain first, fallback to snippet
    let body = msgRes.data.snippet ?? "";
    const parts = msgRes.data.payload?.parts ?? [];
    const textPart = parts.find((p) => p.mimeType === "text/plain");
    if (textPart?.body?.data) {
      body = decodeBase64(textPart.body.data);
    } else if (msgRes.data.payload?.body?.data) {
      body = decodeBase64(msgRes.data.payload.body.data);
    }

    return {
      success: true,
      message: "Email read successfully",
      data: {
        message_id: messageId,
        thread_id: msgRes.data.threadId ?? "",
        from,
        subject,
        body,
        date,
      },
      emitEventKey: "gmail.email_read",
      cost: 2,
    };
  }
}

// ── GmailSendAction ───────────────────────────────────────────

export class GmailSendAction extends ToolAction {
  readonly key = "gmail.send";
  readonly description =
    "Send a new email via Gmail. Requires: to (recipient address), subject, and body.";

  async execute(
    args: Record<string, unknown>,
    _state: IState
  ): Promise<IToolExecutionResult> {
    const to = args.to as string;
    const subject = args.subject as string;
    const body = args.body as string;

    if (!to || !subject || !body) {
      return { success: false, message: "Missing required args: to, subject, body", cost: 0 };
    }

    const gmail = getGmail();
    const raw = buildRawEmail(to, subject, body);

    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });

    return {
      success: true,
      message: "Email sent successfully",
      data: {
        message_id: res.data.id ?? "",
        thread_id: res.data.threadId ?? "",
        to,
        subject,
        sent_at: new Date().toISOString(),
      },
      emitEventKey: "gmail.email_sent",
      cost: 2,
    };
  }
}

// ── GmailReplyAction ──────────────────────────────────────────

export class GmailReplyAction extends ToolAction {
  readonly key = "gmail.reply";
  readonly description =
    "Reply to an existing Gmail thread. Requires: message_id (original message to reply to), body. Optionally: subject override.";

  async execute(
    args: Record<string, unknown>,
    state: IState
  ): Promise<IToolExecutionResult> {
    const messageId = (args.message_id ?? state.data.message_id) as string;
    const body = args.body as string;

    if (!messageId || !body) {
      return { success: false, message: "Missing required args: message_id, body", cost: 0 };
    }

    const gmail = getGmail();

    // Fetch original message to get thread, sender, subject
    const original = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Message-ID"],
    });

    const headers = original.data.payload?.headers ?? [];
    const from = extractHeader(headers, "from");
    const subject = extractHeader(headers, "subject");
    const inReplyTo = extractHeader(headers, "message-id");
    const threadId = original.data.threadId ?? "";

    const raw = buildRawReply(from, subject, body, threadId, inReplyTo);

    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId },
    });

    return {
      success: true,
      message: "Reply sent successfully",
      data: {
        message_id: res.data.id ?? "",
        thread_id: threadId,
        replied_to: from,
        sent_at: new Date().toISOString(),
      },
      emitEventKey: "gmail.reply_sent",
      cost: 3,
    };
  }
}

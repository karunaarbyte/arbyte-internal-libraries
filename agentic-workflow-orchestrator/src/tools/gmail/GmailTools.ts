import { google } from "googleapis";
import type { IState } from "fsm-orchestrator";
import { ToolAction, fromState, stripTrailingSignature } from "../base";
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

// Dedup at task+message level — prevents the same task from processing the same message twice
// (e.g. if Pub/Sub re-delivers with a different historyId). Scoped to task_id so a new task
// created for the same email (e.g. after a prior task failed) is not blocked.
const _processedMessageIds = new Set<string>();

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

    const taskId = (state.data.task_id as string | undefined) ?? "unknown";
    const dedupKey = `${taskId}:${messageId}`;

    if (_processedMessageIds.has(dedupKey)) {
      console.log(`[GmailReadAction] Message "${messageId}" already processed by task "${taskId}" — skipping`);
      return { success: false, message: "Message already processed", cost: 0 };
    }

    // Mark before fetch so concurrent re-deliveries for the same task don't both call messages.get.
    // On transient failure we remove it so the next delivery can retry.
    _processedMessageIds.add(dedupKey);
    if (_processedMessageIds.size > 500)
      _processedMessageIds.delete(_processedMessageIds.values().next().value!);

    let msgRes: Awaited<ReturnType<typeof gmail.users.messages.get>>;
    try {
      msgRes = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      });
    } catch (err) {
      // Transient error — remove from dedup set so the next Pub/Sub delivery can retry
      _processedMessageIds.delete(dedupKey);
      throw err;
    }

    const headers = msgRes.data.payload?.headers ?? [];
    const from = extractHeader(headers, "from");
    const subject = extractHeader(headers, "subject");
    const date = extractHeader(headers, "date");

    // Loop guard — skip emails sent from the authenticated account itself
    const ownEmail = process.env.GMAIL_USER_EMAIL ?? "";
    if (ownEmail && from.includes(ownEmail)) {
      console.log(`[GmailReadAction] Email from self (${from}) — skipping to prevent loop`);
      // Keep in processed set — self-sent messages should never trigger the workflow
      return { success: false, message: "Email from self — skipped", cost: 0 };
    }

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
    state: IState
  ): Promise<IToolExecutionResult> {
    const to = args.to as string;
    const subject = args.subject as string;
    // Prefer state draft (full) over LLM arg (may be truncated by resolver context)
    const draftBody = fromState(state, ["reply_body", "draft_body", "draft", "email_body"], args.body);
    const body = draftBody ? stripTrailingSignature(draftBody) : draftBody;

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
    const approvedBy = (state.data.approved_by ?? args.approved_by) as string | undefined;
    // Prefer state draft (full) over LLM arg (may be truncated by resolver context)
    const draftBody = fromState(state, ["reply_body", "draft_body", "draft", "email_body"], args.body);
    // Strip any sign-off the LLM included, then append the authoritative signature
    const cleanBody = draftBody ? stripTrailingSignature(draftBody) : draftBody;
    const body = approvedBy && cleanBody
      ? `${cleanBody}\n\nBest,\n${approvedBy}`
      : cleanBody;

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

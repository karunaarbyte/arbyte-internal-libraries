import { google } from "googleapis";
import type { IState } from "fsm-orchestrator";
import { ToolAction, fromState, stripTrailingSignature } from "../base";
import type { ArgDef, IToolExecutionResult } from "../../types";
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
    "Read the most recent new email triggered by a Gmail Pub/Sub notification. " +
    "Reads state.data.start_history_id (the cursor set by the webhook) to find the message. " +
    "Returns: message_id, thread_id, from (sender address), subject, body, date.";

  override readonly inputSchema: ArgDef[] = [
    {
      name: "start_history_id",
      description: "The Gmail history cursor set by the webhook. Read from state.data.start_history_id. Do not generate this value.",
      source: "state",
      required: false,
      stateKeys: ["start_history_id"],
    },
  ];

  override readonly outputFields = ["message_id", "thread_id", "from", "subject", "body", "date"];

  async execute(
    args: Record<string, unknown>,
    state: IState
  ): Promise<IToolExecutionResult> {
    const gmail = getGmail();

    // start_history_id is the cursor (previous notification's historyId).
    // history.list(startHistoryId=X) returns changes AFTER X, so using the
    // notification's own historyId would always return empty.
    const historyId = (state.data.start_history_id ?? args.start_history_id) as string | undefined;

    let messageId: string | undefined;

    if (historyId) {
      console.log(`[GmailReadAction] Fetching history since historyId="${historyId}"`);
      const historyRes = await gmail.users.history.list({
        userId: "me",
        startHistoryId: historyId,
        historyTypes: ["messageAdded"],
      });
      const messages = historyRes.data.history?.flatMap(
        (h) => h.messagesAdded?.map((m) => m.message?.id) ?? []
      ) ?? [];
      messageId = messages[0] ?? undefined;
      console.log(`[GmailReadAction] History lookup: ${messages.length} message(s) — using "${messageId ?? "none"}"`);

      if (!messageId) {
        return { success: false, message: "No new messages in this history window — skipping", failureKind: "skip" };
      }
    } else {
      console.log(`[GmailReadAction] No historyId — fetching latest unread`);
      const listRes = await gmail.users.messages.list({
        userId: "me",
        q: "is:unread",
        maxResults: 1,
      });
      messageId = listRes.data.messages?.[0]?.id ?? undefined;
      console.log(`[GmailReadAction] Unread lookup: "${messageId ?? "none"}"`);
    }

    if (!messageId) {
      return { success: false, message: "No unread messages found", failureKind: "tool_error", cost: 1 };
    }

    const taskId = (state.data.task_id as string | undefined) ?? "unknown";
    const dedupKey = `${taskId}:${messageId}`;

    if (_processedMessageIds.has(dedupKey)) {
      console.log(`[GmailReadAction] Message "${messageId}" already processed by task "${taskId}" — skipping`);
      return { success: false, message: "Message already processed", failureKind: "skip" };
    }

    // Mark before fetch so concurrent re-deliveries for the same task don't both call messages.get.
    // On transient failure we remove it so the next delivery can retry.
    _processedMessageIds.add(dedupKey);
    if (_processedMessageIds.size > 500)
      _processedMessageIds.delete(_processedMessageIds.values().next().value!);

    console.log(`[GmailReadAction] Fetching message "${messageId}"`);
    const msgRes = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    }).catch((err: unknown) => {
      // Transient error — remove from dedup set so the next Pub/Sub delivery can retry
      _processedMessageIds.delete(dedupKey);
      throw err;
    });
    console.log(`[GmailReadAction] Fetched message "${messageId}" OK`);

    const headers = msgRes.data.payload?.headers ?? [];
    const from = extractHeader(headers, "from");
    const subject = extractHeader(headers, "subject");
    const date = extractHeader(headers, "date");

    // Loop guard — skip emails sent from the authenticated account itself
    const ownEmail = process.env.GMAIL_USER_EMAIL ?? "";
    if (ownEmail && from.includes(ownEmail)) {
      console.log(`[GmailReadAction] Email from self (${from}) — skipping to prevent loop`);
      return { success: false, message: "Email from self — skipped", failureKind: "skip" };
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
    "Send a new Gmail email. " +
    "Requires: to (recipient email address), subject (email subject line), body (email body text). " +
    "Read body from state.data using the key where the draft was stored (e.g. state.data.reply_body). " +
    "Do not re-draft the body — use the stored draft value.";

  override readonly inputSchema: ArgDef[] = [
    {
      name: "to",
      description: "Recipient email address. Generate from state.data.from (the sender of the original email) or from the step description.",
      source: "llm",
      required: true,
    },
    {
      name: "subject",
      description: "Email subject line. Use state.data.subject if replying, or generate from step description.",
      source: "llm",
      required: true,
    },
    {
      name: "body",
      description: "Email body text. Read from state.data.reply_body (or draft_body / draft / email_body). Do not re-draft.",
      source: "state",
      required: true,
      stateKeys: ["reply_body", "draft_body", "draft", "email_body"],
    },
  ];

  override readonly outputFields = ["message_id", "thread_id", "to", "subject", "sent_at"];

  async execute(
    args: Record<string, unknown>,
    state: IState
  ): Promise<IToolExecutionResult> {
    const to = args.to as string;
    const subject = args.subject as string;
    const draftBody = fromState(state, ["reply_body", "draft_body", "draft", "email_body"], args.body);
    const body = draftBody ? stripTrailingSignature(draftBody) : draftBody;

    if (!to || !subject || !body) {
      return { success: false, message: "Missing required args: to, subject, body", failureKind: "arg_error" };
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
    "Reply to an existing Gmail thread using the original message ID. " +
    "Read message_id from state.data.message_id (set by the gmail.read step). " +
    "Read the reply body from state.data — check reply_body, then draft_body, then draft, then email_body in that order. " +
    "Do not re-draft the reply body — use the stored draft value. " +
    "Pass message_id as the only required arg; body is read from state automatically.";

  override readonly inputSchema: ArgDef[] = [
    {
      name: "message_id",
      description: "The Gmail message ID of the original email to reply to. Read from state.data.message_id.",
      source: "state",
      required: true,
      stateKeys: ["message_id"],
    },
    {
      name: "body",
      description: "The reply text. Read from state.data.reply_body (or draft_body / draft / email_body). Do not generate — use the stored draft.",
      source: "state",
      required: true,
      stateKeys: ["reply_body", "draft_body", "draft", "email_body"],
    },
  ];

  override readonly outputFields = ["message_id", "thread_id", "replied_to", "sent_at"];

  async execute(
    args: Record<string, unknown>,
    state: IState
  ): Promise<IToolExecutionResult> {
    const messageId = (args.message_id ?? state.data.message_id) as string;
    const approvedBy = (state.data.approved_by ?? args.approved_by) as string | undefined;
    const draftBody = fromState(state, ["reply_body", "draft_body", "draft", "email_body"], args.body);
    const cleanBody = draftBody ? stripTrailingSignature(draftBody) : draftBody;
    const body = approvedBy && cleanBody
      ? `${cleanBody}\n\nBest,\n${approvedBy}`
      : cleanBody;

    if (!messageId || !body) {
      return { success: false, message: "Missing required args: message_id, body", failureKind: "arg_error" };
    }

    const gmail = getGmail();

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

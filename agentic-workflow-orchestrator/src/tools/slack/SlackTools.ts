import type { IState } from "fsm-orchestrator";
import type { Block, KnownBlock } from "@slack/web-api";
import { ToolAction, fromState } from "../base";
import type { ArgDef, IToolExecutionResult } from "../../types";
import { getSlackClient } from "../../lib/slack-client";

// ─────────────────────────────────────────────────────────────
// Slack Tools — real Slack Web API implementations.
//
// Auth: Bot token via getSlackClient() (SLACK_BOT_TOKEN env var).
// ─────────────────────────────────────────────────────────────

// ── SlackSendMessageAction ────────────────────────────────────

export class SlackSendMessageAction extends ToolAction {
  readonly key = "slack.send_message";
  readonly description =
    "Send a message to a Slack channel. " +
    "Read channel from state.data.slack_channel. " +
    "Read message text from state.data — check slack_message_body, then message_body, then draft_body, then draft in that order. " +
    "Do not re-draft the message — use the stored draft value. " +
    "Pass channel as the only required arg; text is read from state automatically.";

  override readonly inputSchema: ArgDef[] = [
    {
      name: "channel",
      description: "Slack channel ID. Read from state.data.slack_channel. Do not generate this value.",
      source: "state",
      required: true,
      stateKeys: ["slack_channel"],
    },
    {
      name: "text",
      description: "Message text. Read from state.data.slack_message_body (or message_body / draft_body / draft). Do not re-draft.",
      source: "state",
      required: true,
      stateKeys: ["slack_message_body", "message_body", "draft_body", "draft"],
    },
  ];

  override readonly outputFields = ["channel", "ts", "sent_at"];

  async execute(
    args: Record<string, unknown>,
    state: IState
  ): Promise<IToolExecutionResult> {
    const channel = (args.channel ?? state.data.slack_channel) as string;
    const text = fromState(state, ["slack_message_body", "message_body", "draft_body", "draft"], args.text);

    if (!channel || !text) {
      return { success: false, message: "Missing required args: channel, text", failureKind: "arg_error" };
    }

    const slack = getSlackClient();
    const res = await slack.chat.postMessage({ channel, text });

    if (!res.ok) {
      return { success: false, message: `Slack API error: ${res.error}`, failureKind: "tool_error", cost: 1 };
    }

    return {
      success: true,
      message: "Slack message sent successfully",
      data: {
        channel: res.channel ?? channel,
        ts: res.ts ?? "",
        sent_at: new Date().toISOString(),
      },
      emitEventKey: "slack.message_sent",
      cost: 1,
    };
  }
}

// ── SlackReadChannelAction ────────────────────────────────────

export class SlackReadChannelAction extends ToolAction {
  readonly key = "slack.read_channel";
  readonly description =
    "Read the most recent messages from a Slack channel. " +
    "Requires: channel (channel ID, e.g. C0AQCED011T). Returns up to 10 recent messages with user, text, and ts fields.";

  override readonly inputSchema: ArgDef[] = [
    {
      name: "channel",
      description: "Slack channel ID to read from (e.g. C0AQCED011T). Generate from step description or read from state.data.slack_channel.",
      source: "llm",
      required: true,
    },
  ];

  override readonly outputFields = ["channel", "messages"];

  async execute(
    args: Record<string, unknown>,
    _state: IState
  ): Promise<IToolExecutionResult> {
    const channel = args.channel as string;

    if (!channel) {
      return { success: false, message: "Missing required arg: channel", failureKind: "arg_error" };
    }

    const slack = getSlackClient();
    const res = await slack.conversations.history({ channel, limit: 10 });

    if (!res.ok) {
      return { success: false, message: `Slack API error: ${res.error}`, failureKind: "tool_error", cost: 1 };
    }

    const messages = (res.messages ?? []).map((m) => ({
      user: m.user ?? "",
      text: m.text ?? "",
      ts: m.ts ?? "",
    }));

    return {
      success: true,
      message: "Channel messages read successfully",
      data: { channel, messages },
      emitEventKey: "slack.channel_read",
      cost: 1,
    };
  }
}

// ── SlackSendApprovalRequestAction ───────────────────────────

export class SlackSendApprovalRequestAction extends ToolAction {
  readonly key = "slack.send_approval_request";
  readonly description =
    "Send a Slack message with Approve and Reject buttons for human-in-the-loop approval. " +
    "Read channel from state.data.slack_channel. " +
    "Read the draft to display from state.data — check reply_body, then draft_body, then draft in that order (pass as draft_body arg). " +
    "Provide a brief text summary of what is being approved (e.g. 'Approve reply to Alice re: Q2 Planning?'). " +
    "task_id is read from state automatically — do not provide it.";

  override readonly inputSchema: ArgDef[] = [
    {
      name: "channel",
      description: "Slack channel ID. Read from state.data.slack_channel. Do not generate this value.",
      source: "state",
      required: true,
      stateKeys: ["slack_channel"],
    },
    {
      name: "draft_body",
      description: "The full draft text to show approvers. Read from state.data.reply_body (or draft_body / draft). Do not re-draft.",
      source: "state",
      required: true,
      stateKeys: ["reply_body", "draft_body", "draft"],
    },
    {
      name: "text",
      description: "Brief one-line context shown above the draft (e.g. 'Approve reply to Alice re: Q2 Planning?'). Generate this from state.data.from and state.data.subject.",
      source: "llm",
      required: true,
    },
    {
      name: "task_id",
      description: "The current task ID. Read from state.data.task_id. Do not generate this value.",
      source: "state",
      required: true,
      stateKeys: ["task_id"],
    },
  ];

  override readonly outputFields = ["channel", "ts", "approval_pending", "sent_at"];

  async execute(
    args: Record<string, unknown>,
    state: IState
  ): Promise<IToolExecutionResult> {
    const channel = (args.channel ?? state.data.slack_channel) as string;
    const text = args.text as string;
    const taskId = state.data.task_id as string;
    // Only read thread_ts from state — never from LLM args to prevent hallucination
    const rawThreadTs = state.data.thread_ts ?? state.data.ts;
    const threadTs = rawThreadTs && /^\d+\.\d+$/.test(String(rawThreadTs)) ? String(rawThreadTs) : undefined;

    const draftBody = fromState(
      state,
      ["reply_body", "draft_body", "draft", "email_body"],
      args.draft_body ?? args.draft
    );

    if (!channel || !text || !taskId) {
      return { success: false, message: "Missing required args: channel, text, task_id", failureKind: "arg_error" };
    }

    const slack = getSlackClient();

    const blocks: (Block | KnownBlock)[] = [
      {
        type: "section",
        text: { type: "mrkdwn", text },
      },
    ];

    if (draftBody) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*Draft email:*\n\`\`\`${draftBody}\`\`\`` },
      });
    }

    blocks.push({
      type: "actions",
      block_id: "approval_actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ Approve", emoji: true },
          style: "primary",
          action_id: "approval_granted",
          value: taskId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❌ Reject", emoji: true },
          style: "danger",
          action_id: "approval_rejected",
          value: taskId,
        },
      ],
    });

    const res = await slack.chat.postMessage({
      channel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text,
      blocks,
    });

    if (!res.ok) {
      return { success: false, message: `Slack API error: ${res.error}`, failureKind: "tool_error", cost: 1 };
    }

    return {
      success: true,
      message: "Approval request sent",
      data: {
        channel: res.channel ?? channel,
        ts: res.ts ?? "",
        approval_pending: true,
        sent_at: new Date().toISOString(),
      },
      cost: 1,
    };
  }
}

// ── SlackReplyThreadAction ────────────────────────────────────

export class SlackReplyThreadAction extends ToolAction {
  readonly key = "slack.reply_thread";
  readonly description =
    "Reply to an existing Slack thread. " +
    "Read channel from state.data.channel or state.data.slack_channel. " +
    "Read thread_ts from state.data.thread_ts or state.data.ts. " +
    "Read reply text from state.data — check slack_message_body, then message_body, then draft_body, then draft. " +
    "Pass channel and thread_ts as args; text is read from state automatically.";

  override readonly inputSchema: ArgDef[] = [
    {
      name: "channel",
      description: "Slack channel ID. Read from state.data.channel or state.data.slack_channel.",
      source: "state",
      required: true,
      stateKeys: ["channel", "slack_channel"],
    },
    {
      name: "thread_ts",
      description: "Timestamp of the parent Slack message to reply to. Read from state.data.thread_ts or state.data.ts. Format: '1234567890.123456'. Do not generate this value.",
      source: "state",
      required: true,
      stateKeys: ["thread_ts", "ts"],
    },
    {
      name: "text",
      description: "Reply text. Read from state.data.slack_message_body (or message_body / draft_body / draft). Do not re-draft.",
      source: "state",
      required: true,
      stateKeys: ["slack_message_body", "message_body", "draft_body", "draft"],
    },
  ];

  override readonly outputFields = ["channel", "thread_ts", "ts", "sent_at"];

  async execute(
    args: Record<string, unknown>,
    state: IState
  ): Promise<IToolExecutionResult> {
    const channel = (args.channel ?? state.data.channel) as string;
    const thread_ts = (args.thread_ts ?? state.data.thread_ts ?? state.data.ts) as string;
    const text = fromState(state, ["slack_message_body", "message_body", "draft_body", "draft"], args.text);

    if (!channel || !thread_ts || !text) {
      return { success: false, message: "Missing required args: channel, thread_ts, text", failureKind: "arg_error" };
    }

    const slack = getSlackClient();
    const res = await slack.chat.postMessage({ channel, thread_ts, text });

    if (!res.ok) {
      return { success: false, message: `Slack API error: ${res.error}`, failureKind: "tool_error", cost: 1 };
    }

    return {
      success: true,
      message: "Thread reply sent successfully",
      data: {
        channel: res.channel ?? channel,
        thread_ts,
        ts: res.ts ?? "",
        sent_at: new Date().toISOString(),
      },
      emitEventKey: "slack.thread_replied",
      cost: 1,
    };
  }
}

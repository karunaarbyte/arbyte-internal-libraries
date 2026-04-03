import type { IState } from "fsm-orchestrator";
import { ToolAction, fromState } from "../base";
import type { IToolExecutionResult } from "../../types";
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
    "Send a message to a Slack channel or user. Requires: channel (channel ID or name) and text (message content).";

  async execute(
    args: Record<string, unknown>,
    state: IState
  ): Promise<IToolExecutionResult> {
    const channel = args.channel as string;
    // Prefer state draft (full) over LLM arg (may be truncated by resolver context)
    const text = fromState(state, ["slack_message_body", "message_body", "draft_body", "draft"], args.text);

    if (!channel || !text) {
      return { success: false, message: "Missing required args: channel, text", cost: 0 };
    }

    const slack = getSlackClient();
    const res = await slack.chat.postMessage({ channel, text });

    if (!res.ok) {
      return { success: false, message: `Slack API error: ${res.error}`, cost: 1 };
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
    "Read the most recent messages from a Slack channel. Requires: channel (channel ID or name). Returns up to 10 recent messages.";

  async execute(
    args: Record<string, unknown>,
    _state: IState
  ): Promise<IToolExecutionResult> {
    const channel = args.channel as string;

    if (!channel) {
      return { success: false, message: "Missing required arg: channel", cost: 0 };
    }

    const slack = getSlackClient();
    const res = await slack.conversations.history({ channel, limit: 10 });

    if (!res.ok) {
      return { success: false, message: `Slack API error: ${res.error}`, cost: 1 };
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
    "Requires: channel, text (brief context shown above the draft), task_id (used to resume the workflow on click). " +
    "Pass draft_body (the full drafted email text) so approvers can read it before deciding. " +
    "Optionally: thread_ts (to post in a thread).";

  async execute(
    args: Record<string, unknown>,
    state: IState
  ): Promise<IToolExecutionResult> {
    const channel = (args.channel ?? state.data.slack_channel) as string;
    const text = args.text as string;
    // Always use task_id from state — never trust LLM-provided args for this
    const taskId = state.data.task_id as string;
    const threadTs = (args.thread_ts ?? state.data.ts) as string | undefined;

    // Find the draft to show — prefer state (full) over LLM arg (may be truncated)
    const draftBody = fromState(
      state,
      ["reply_body", "draft_body", "draft", "email_body"],
      args.draft_body ?? args.draft
    );

    if (!channel || !text || !taskId) {
      return { success: false, message: "Missing required args: channel, text, task_id", cost: 0 };
    }

    const slack = getSlackClient();

    const blocks: object[] = [
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
      return { success: false, message: `Slack API error: ${res.error}`, cost: 1 };
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
    "Reply to an existing Slack thread. Requires: channel, thread_ts (timestamp of the parent message), and text.";

  async execute(
    args: Record<string, unknown>,
    state: IState
  ): Promise<IToolExecutionResult> {
    const channel = (args.channel ?? state.data.channel) as string;
    const thread_ts = (args.thread_ts ?? state.data.thread_ts ?? state.data.ts) as string;
    // Prefer state draft (full) over LLM arg (may be truncated by resolver context)
    const text = fromState(state, ["slack_message_body", "message_body", "draft_body", "draft"], args.text);

    if (!channel || !thread_ts || !text) {
      return { success: false, message: "Missing required args: channel, thread_ts, text", cost: 0 };
    }

    const slack = getSlackClient();
    const res = await slack.chat.postMessage({ channel, thread_ts, text });

    if (!res.ok) {
      return { success: false, message: `Slack API error: ${res.error}`, cost: 1 };
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

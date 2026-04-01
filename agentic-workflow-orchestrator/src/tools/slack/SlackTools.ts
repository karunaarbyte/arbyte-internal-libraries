import type { IState } from "fsm-orchestrator";
import { ToolAction } from "../base";
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
    _state: IState
  ): Promise<IToolExecutionResult> {
    const channel = args.channel as string;
    const text = args.text as string;

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
    const text = args.text as string;

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

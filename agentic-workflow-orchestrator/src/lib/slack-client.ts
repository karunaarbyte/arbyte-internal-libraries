import { WebClient } from "@slack/web-api";

// ─────────────────────────────────────────────────────────────
// Slack WebClient — shared singleton used by all Slack tools.
// ─────────────────────────────────────────────────────────────

let _client: WebClient | null = null;

export const getSlackClient = (): WebClient => {
  if (_client) return _client;

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN is not set");

  _client = new WebClient(token);
  return _client;
};

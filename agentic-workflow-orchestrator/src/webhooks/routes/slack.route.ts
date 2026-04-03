import { Hono } from "hono";
import type { AgenticOrchestrator } from "../../orchestrator/AgenticOrchestrator";

// ─────────────────────────────────────────────────────────────
// Slack webhook route — receives Slack Events API payloads.
//
// Slack sends a url_verification challenge on first setup —
// this route handles it automatically.
// All other events are normalized to IEvent and fired.
// ─────────────────────────────────────────────────────────────

export const buildSlackRoute = (orchestrator: AgenticOrchestrator): Hono => {
  const route = new Hono();

  route.post("/", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // Slack URL verification handshake
    if (body.type === "url_verification") {
      return c.json({ challenge: body.challenge }, 200);
    }

    const slackEvent = body.event as Record<string, unknown> | undefined;
    if (!slackEvent) {
      return c.json({ received: true }, 200);
    }

    // Ignore bot messages (including our own outbound notifications)
    if (slackEvent.bot_id || slackEvent.subtype === "bot_message") {
      return c.json({ received: true }, 200);
    }

    const eventType = slackEvent.type as string | undefined;

    const event = {
      key: `slack.${eventType ?? "event"}`,
      payload: {
        team_id: body.team_id ?? "",
        channel: slackEvent.channel ?? "",
        user: slackEvent.user ?? "",
        text: slackEvent.text ?? "",
        ts: slackEvent.ts ?? "",
        thread_ts: slackEvent.thread_ts ?? slackEvent.ts ?? "",
        received_at: new Date().toISOString(),
      },
    };

    (async () => {
      try {
        const workflowKeys = await orchestrator.getWorkflowKeysByTrigger(event.key);

        if (workflowKeys.length === 0) {
          console.warn(`[slack.route] No workflow found for trigger "${event.key}"`);
          return;
        }

        await Promise.allSettled(
          workflowKeys.map(async (key) => {
            const task = orchestrator.initTask(key, event.payload);
            await orchestrator.handleEvent(task.id, event);
          })
        );
      } catch (err) {
        console.error("[slack.route] Event handling failed:", err);
      }
    })();

    return c.json({ received: true }, 200);
  });

  return route;
};

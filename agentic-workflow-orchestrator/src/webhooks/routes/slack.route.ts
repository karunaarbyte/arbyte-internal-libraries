import { Hono } from "hono";
import type { AgenticOrchestrator } from "../../orchestrator/AgenticOrchestrator";

// ─────────────────────────────────────────────────────────────
// Slack webhook route — receives Slack Events API payloads.
//
// Slack sends a url_verification challenge on first setup —
// this route handles it automatically.
// All other events are normalized to IEvent and fired.
// ─────────────────────────────────────────────────────────────

const WORKFLOW_KEY = "slack";

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

    c.executionCtx?.waitUntil(
      (async () => {
        try {
          const workflow = orchestrator
            .getWorkflows()
            .find((w) => w.key.startsWith(WORKFLOW_KEY));

          if (!workflow) {
            console.warn(`[slack.route] No workflow found for source "${WORKFLOW_KEY}"`);
            return;
          }

          const task = orchestrator.initTask(workflow.key, event.payload);
          await orchestrator.handleEvent(task.id, event);
        } catch (err) {
          console.error("[slack.route] Event handling failed:", err);
        }
      })()
    );

    return c.json({ received: true }, 200);
  });

  return route;
};

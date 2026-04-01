import { Hono } from "hono";
import type { AgenticOrchestrator } from "../../orchestrator/AgenticOrchestrator";

// ─────────────────────────────────────────────────────────────
// Gmail webhook route — receives Gmail push notifications via
// Google Pub/Sub. Normalizes to IEvent and fires the orchestrator.
//
// Gmail sends Pub/Sub messages as base64-encoded JSON in the body:
//   { message: { data: "<base64>", messageId: "...", publishTime: "..." } }
// The decoded data contains: { emailAddress, historyId }
// ─────────────────────────────────────────────────────────────

const WORKFLOW_KEY = "gmail"; // matches WorkflowDefinition.trigger.source

export const buildGmailRoute = (orchestrator: AgenticOrchestrator): Hono => {
  const route = new Hono();

  route.post("/", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // Decode Pub/Sub message
    const message = body.message as Record<string, unknown> | undefined;
    const rawData = message?.data as string | undefined;

    let emailData: Record<string, unknown> = {};
    if (rawData) {
      try {
        const decoded = Buffer.from(rawData, "base64").toString("utf-8");
        emailData = JSON.parse(decoded);
      } catch {
        console.warn("[gmail.route] Failed to decode Pub/Sub message data");
      }
    }

    const event = {
      key: "gmail.email_received",
      payload: {
        email_address: emailData.emailAddress ?? "",
        history_id: emailData.historyId ?? "",
        message_id: message?.messageId ?? "",
        received_at: new Date().toISOString(),
      },
    };

    // ACK immediately, process async
    c.executionCtx?.waitUntil(
      (async () => {
        try {
          const workflow = orchestrator
            .getWorkflows()
            .find((w) => w.key.startsWith(WORKFLOW_KEY));

          if (!workflow) {
            console.warn(`[gmail.route] No workflow found for source "${WORKFLOW_KEY}"`);
            return;
          }

          const task = orchestrator.initTask(workflow.key, event.payload);
          await orchestrator.handleEvent(task.id, event);
        } catch (err) {
          console.error("[gmail.route] Event handling failed:", err);
        }
      })()
    );

    return c.json({ received: true }, 200);
  });

  return route;
};

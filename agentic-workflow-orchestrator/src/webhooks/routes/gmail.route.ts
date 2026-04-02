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

const TRIGGER_EVENT_KEY = "gmail.email_received";
const _processedHistoryIds = new Set<string>();

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
        slack_channel: process.env.SLACK_DEFAULT_CHANNEL ?? "",
      },
    };

    // ACK immediately, process async
    (async () => {
      try {
        const historyId = String(emailData.historyId ?? "");
        if (historyId && _processedHistoryIds.has(historyId)) {
          console.log(`[gmail.route] Duplicate history_id "${historyId}" — ignoring`);
          return;
        }

        const workflowKeys = await orchestrator.getWorkflowKeysByTrigger(TRIGGER_EVENT_KEY);

        if (workflowKeys.length === 0) {
          console.warn(`[gmail.route] No workflow found for trigger "${TRIGGER_EVENT_KEY}"`);
          return;
        }

        const results = await Promise.allSettled(
          workflowKeys.map(async (key) => {
            const task = orchestrator.initTask(key, event.payload);
            await orchestrator.handleEvent(task.id, event);
          })
        );

        // Only mark processed if at least one workflow succeeded — failed ones remain retryable
        const anySucceeded = results.some((r) => r.status === "fulfilled");
        if (historyId && anySucceeded) {
          _processedHistoryIds.add(historyId);
          if (_processedHistoryIds.size > 500)
            _processedHistoryIds.delete(_processedHistoryIds.values().next().value!);
        }
      } catch (err) {
        console.error("[gmail.route] Event handling failed:", err);
      }
    })();

    return c.json({ received: true }, 200);
  });

  return route;
};

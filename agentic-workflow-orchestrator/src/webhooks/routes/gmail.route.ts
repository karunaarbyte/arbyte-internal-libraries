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

// Cursor tracking — the startHistoryId for the next history.list call.
// history.list(startHistoryId=X) returns changes AFTER X, so this must be
// a real historyId from a prior Gmail response, never an arithmetic derivation.
// Bootstrapped at boot via setGmailHistoryCursor(); seeded from env as fallback.
let _lastHistoryId: string | undefined = process.env.GMAIL_HISTORY_ID;

export const setGmailHistoryCursor = (historyId: string): void => {
  _lastHistoryId = historyId;
};

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

    // Dedup synchronously before ACKing — prevents two near-simultaneous Pub/Sub
    // deliveries of the same historyId both slipping through before either completes.
    // Trade-off: if some workflows succeed and others fail, the historyId stays locked
    // and the failed workflows won't be retried. Acceptable because per-message dedup
    // in GmailReadAction provides a second layer of protection.
    const historyId = String(emailData.historyId ?? "");

    // If no cursor yet, skip this notification — cursor must be bootstrapped at boot
    // via setGmailHistoryCursor(). Arithmetic derivation from the notification's
    // historyId is unsafe: Gmail historyIds are opaque cursors, not arithmetic values.
    if (!_lastHistoryId) {
      console.warn(`[gmail.route] No history cursor set — skipping notification historyId="${historyId}". ` +
        `Ensure Gmail watch registration succeeded at boot.`);
      return c.json({ received: true }, 200);
    }

    const event = {
      key: "gmail.email_received",
      payload: {
        history_id: emailData.historyId ?? "",
        start_history_id: _lastHistoryId,
        message_id: message?.messageId ?? "",
        received_at: new Date().toISOString(),
        slack_channel: process.env.SLACK_DEFAULT_CHANNEL ?? "",
      },
    };
    if (historyId && _processedHistoryIds.has(historyId)) {
      console.log(`[gmail.route] Duplicate history_id "${historyId}" — ignoring`);
      return c.json({ received: true }, 200);
    }
    if (historyId) {
      _processedHistoryIds.add(historyId);
      if (_processedHistoryIds.size > 500)
        _processedHistoryIds.delete(_processedHistoryIds.values().next().value!);
    }

    // ACK immediately, process async
    (async () => {
      try {
        const workflowKeys = await orchestrator.getWorkflowKeysByTrigger(TRIGGER_EVENT_KEY);
        console.log(`[gmail.route] historyId=${historyId} — matched workflows: [${workflowKeys.join(", ") || "none"}]`);

        if (workflowKeys.length === 0) {
          console.warn(`[gmail.route] No active workflow found for trigger "${TRIGGER_EVENT_KEY}" — is a skill compiled and stored?`);
          return;
        }

        const outcomes = await Promise.allSettled(
          workflowKeys.map(async (key) => {
            const task = orchestrator.initTask(key, event.payload);
            console.log(`[gmail.route] Created task "${task.id}" for workflow "${key}"`);
            const logs = await orchestrator.handleEvent(task.id, event);
            const skipped = logs.filter((l) => !l.success && l.action_log_data?.data?.failureKind === "skip");
            const failed = logs.filter((l) => !l.success && l.action_log_data?.data?.failureKind !== "skip");
            skipped.forEach((l) => console.log(`[gmail.route] task="${task.id}" skipped: ${l.action_log_data?.message}`));
            failed.forEach((l) => console.error(`[gmail.route] task="${task.id}" step failed: ${l.action_log_data?.message}`));
            // First log reflects the Gmail-level result (did we read the email?).
            // Downstream step failures are workflow-level, not Gmail-level.
            const firstLog = logs[0];
            return firstLog?.success === true || firstLog?.action_log_data?.data?.failureKind === "skip";
          })
        );

        outcomes.forEach((r, i) => {
          if (r.status === "rejected") {
            console.error(`[gmail.route] workflow[${workflowKeys[i]}] threw:`, r.reason);
          }
        });

        // Advance cursor whenever the Gmail-level step was handled (read or intentional skip).
        // Only release the dedup lock if every workflow threw — allowing Pub/Sub to retry.
        const anyHandled = outcomes.some((r) => r.status === "fulfilled" && r.value === true);
        const allThrew = outcomes.every((r) => r.status === "rejected");
        if (historyId && anyHandled) {
          _lastHistoryId = historyId;
        }
        if (historyId && allThrew) {
          _processedHistoryIds.delete(historyId);
        }
      } catch (err) {
        console.error("[gmail.route] Event handling failed:", err);
        // Unexpected exception — release the lock so Pub/Sub retries are not permanently dropped
        if (historyId) _processedHistoryIds.delete(historyId);
      }
    })();

    return c.json({ received: true }, 200);
  });

  return route;
};

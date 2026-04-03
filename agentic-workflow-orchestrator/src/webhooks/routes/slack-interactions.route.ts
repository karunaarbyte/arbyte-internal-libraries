import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "crypto";
import type { AgenticOrchestrator } from "../../orchestrator/AgenticOrchestrator";

// ─────────────────────────────────────────────────────────────
// Slack interactive components route — receives button click
// payloads from Slack Block Kit messages.
//
// Slack sends interactions as URL-encoded form data with a
// single "payload" field containing JSON.
//
// Flow:
//   User clicks Approve/Reject button
//   → POST /webhooks/slack/interactions
//   → Extract task_id from button value
//   → Fire orchestrator.handleEvent(task_id, event)
//   → Workflow resumes from awaiting_approval step
// ─────────────────────────────────────────────────────────────

const verifySlackSignature = async (c: ReturnType<Hono["request"]>, rawBody: string): Promise<boolean> => {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    console.warn("[slack-interactions.route] SLACK_SIGNING_SECRET not set — skipping verification");
    return true;
  }

  const timestamp = (c as any).req.header("x-slack-request-timestamp");
  const signature = (c as any).req.header("x-slack-signature");

  if (!timestamp || !signature) return false;

  // Reject requests older than 5 minutes to prevent replay attacks
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const expected = "v0=" + createHmac("sha256", signingSecret).update(baseString).digest("hex");

  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
};

export const buildSlackInteractionsRoute = (orchestrator: AgenticOrchestrator): Hono => {
  const route = new Hono();

  route.post("/", async (c) => {
    let payload: Record<string, unknown>;

    // Slack sends interactions as application/x-www-form-urlencoded
    try {
      const rawBody = await c.req.text();

      if (!await verifySlackSignature(c as any, rawBody)) {
        return c.json({ error: "Invalid signature" }, 401);
      }

      const formData = new URLSearchParams(rawBody);
      const rawPayload = formData.get("payload");
      if (!rawPayload || typeof rawPayload !== "string") {
        return c.json({ error: "Missing payload" }, 400);
      }
      payload = JSON.parse(rawPayload);
    } catch {
      return c.json({ error: "Invalid payload" }, 400);
    }

    const actions = payload.actions as Array<Record<string, unknown>> | undefined;
    const action = actions?.[0];

    if (!action) {
      return c.json({ error: "No action in payload" }, 400);
    }

    const actionId = action.action_id as string;
    const taskId = action.value as string;

    if (!taskId) {
      return c.json({ error: "Missing task_id in button value" }, 400);
    }

    const isApproved = actionId === "approval_granted";
    const eventKey = isApproved ? "slack.approval_granted" : "slack.approval_rejected";

    const user = (payload.user as Record<string, unknown>)?.name ?? "unknown";
    console.log(`[slack-interactions.route] ${eventKey} for task "${taskId}" by ${user}`);

    // ACK Slack immediately (must respond within 3 seconds)
    // Replace the buttons with a status message to prevent double-clicks
    const responseUrl = payload.response_url as string | undefined;
    if (responseUrl) {
      fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          replace_original: true,
          text: isApproved
            ? `✅ Approved by ${user} — sending reply...`
            : `❌ Rejected by ${user}`,
        }),
      }).catch(() => {});
    }

    // Resume the paused workflow
    (async () => {
      try {
        const event = {
          key: eventKey,
          payload: { task_id: taskId, approved_by: user, approved_at: new Date().toISOString() },
        };
        await orchestrator.handleEvent(taskId, event);
      } catch (err) {
        console.error(`[slack-interactions.route] Failed to resume task "${taskId}":`, err);
      }
    })();

    return c.json({ ok: true }, 200);
  });

  return route;
};

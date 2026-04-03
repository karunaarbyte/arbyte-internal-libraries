import { Hono } from "hono";
import { buildDriveRoute } from "./routes/drive.route";
import { buildGmailRoute } from "./routes/gmail.route";
import { buildSlackRoute } from "./routes/slack.route";
import { buildSlackInteractionsRoute } from "./routes/slack-interactions.route";
import type { AgenticOrchestrator } from "../orchestrator/AgenticOrchestrator";
import type { DriveWatcher } from "../skill-compiler/DriveWatcher";

// ─────────────────────────────────────────────────────────────
// WebhookServer — Hono app wiring all webhook routes.
//
// Each route is mounted at /webhooks/{source} and is responsible
// only for normalization and orchestrator delegation.
// ─────────────────────────────────────────────────────────────

export type WebhookServerDeps = {
  orchestrator: AgenticOrchestrator;
  driveWatcher: DriveWatcher;
};

export const buildWebhookServer = (deps: WebhookServerDeps): Hono => {
  const app = new Hono();

  app.route("/webhooks/drive", buildDriveRoute(deps.driveWatcher));
  app.route("/webhooks/gmail", buildGmailRoute(deps.orchestrator));
  app.route("/webhooks/slack-interactions", buildSlackInteractionsRoute(deps.orchestrator));
  app.route("/webhooks/slack", buildSlackRoute(deps.orchestrator));

  app.get("/health", (c) => c.json({ status: "ok", ts: new Date().toISOString() }));

  return app;
};

export const startServer = (app: Hono, port = 3000): void => {
  Bun.serve({
    port,
    fetch: app.fetch,
  });
  console.log(`[WebhookServer] Listening on port ${port}`);
};

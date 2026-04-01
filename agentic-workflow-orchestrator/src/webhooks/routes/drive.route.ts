import { Hono } from "hono";
import type { DriveWatcher } from "../../skill-compiler/DriveWatcher";
import type { DriveNotificationHeaders } from "../../skill-compiler/DriveWatcher";

// ─────────────────────────────────────────────────────────────
// Drive webhook route — receives Google Drive push notifications.
// Delegates to DriveWatcher which handles validation + compilation.
// Returns 200 immediately (Drive requires fast ACK).
// ─────────────────────────────────────────────────────────────

export const buildDriveRoute = (watcher: DriveWatcher): Hono => {
  const route = new Hono();

  route.post("/", async (c) => {
    const headers: DriveNotificationHeaders = {
      "x-goog-channel-id": c.req.header("x-goog-channel-id"),
      "x-goog-resource-id": c.req.header("x-goog-resource-id"),
      "x-goog-resource-state": c.req.header("x-goog-resource-state"),
      "x-goog-message-number": c.req.header("x-goog-message-number"),
    };

    // ACK immediately — Drive will retry if we don't respond within 10s
    c.executionCtx?.waitUntil(
      watcher.handleNotification(headers).catch((err) =>
        console.error("[drive.route] Notification handling failed:", err)
      )
    );

    return c.json({ received: true }, 200);
  });

  return route;
};

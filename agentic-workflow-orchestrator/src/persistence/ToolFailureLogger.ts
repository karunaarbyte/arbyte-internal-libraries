import { existsSync, appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

// ─────────────────────────────────────────────────────────────
// ToolFailureLogger — persists genuine tool failures (API errors,
// business logic failures) to a NDJSON file for postmortem review.
//
// Only "tool_error" entries are persisted.
// "skip" is silent. "arg_error" is console.warn only — missing arg
// names are logged but never arg values (may contain PII/email content).
// ─────────────────────────────────────────────────────────────

export type ToolFailureEntry = {
  timestamp: string;
  workflowId: string;
  stepKey: string;
  toolKey: string;
  failureKind: "arg_error" | "tool_error";
  message: string;
  missingArgs?: string[]; // arg_error only — key names only, never values
};

export class ToolFailureLogger {
  private readonly _logFile: string;

  constructor(logFile: string) {
    this._logFile = logFile;
    const dir = dirname(logFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  logArgError(entry: Omit<ToolFailureEntry, "failureKind" | "timestamp">): void {
    const { workflowId, stepKey, toolKey, message, missingArgs } = entry;
    console.warn(
      `[ToolFailureLogger] arg_error workflowId="${workflowId}" step="${stepKey}" tool="${toolKey}" missing=[${(missingArgs ?? []).join(", ")}] msg="${message}"`
    );
  }

  logToolError(entry: Omit<ToolFailureEntry, "failureKind" | "timestamp">): void {
    const full: ToolFailureEntry = {
      ...entry,
      failureKind: "tool_error",
      timestamp: new Date().toISOString(),
    };
    appendFileSync(this._logFile, JSON.stringify(full) + "\n", "utf-8");
    console.error(
      `[ToolFailureLogger] tool_error workflowId="${full.workflowId}" step="${full.stepKey}" tool="${full.toolKey}" msg="${full.message}"`
    );
  }
}

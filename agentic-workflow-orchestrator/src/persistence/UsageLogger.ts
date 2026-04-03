import { existsSync, readFileSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

// ─────────────────────────────────────────────────────────────
// UsageLogger — appends one token usage entry per task run to
// a JSON log file. Each entry captures total tokens across all
// LLM resolver calls made during the task.
// ─────────────────────────────────────────────────────────────

export type UsageEntry = {
  timestamp: string;
  workflowId: string;
  stepKey: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export class UsageLogger {
  private readonly _logFile: string;

  constructor(logFile: string) {
    this._logFile = logFile;
    const dir = dirname(logFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  append(entry: UsageEntry): void {
    appendFileSync(this._logFile, JSON.stringify(entry) + "\n", "utf-8");
    console.log(`[UsageLogger] Logged ${entry.totalTokens} tokens for step "${entry.stepKey}" (${entry.workflowId})`);
  }

  getAll(): UsageEntry[] {
    if (!existsSync(this._logFile)) return [];
    try {
      return readFileSync(this._logFile, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as UsageEntry);
    } catch {
      return [];
    }
  }
}

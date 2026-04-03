// ─────────────────────────────────────────────────────────────
// Tool types — shared contract between ToolAction implementations
// and the LLMActionResolver.
// ─────────────────────────────────────────────────────────────

// Where a required arg comes from at execution time.
export type ArgSource = "state" | "llm" | "params";

// Declares one input argument for a tool.
// source="state": read from state.data — use stateKeys for multi-key fallback (fromState pattern).
// source="llm":   the resolver must generate this value.
// source="params": provided at compile time via StepDefinition.params.
export type ArgDef = {
  name: string;
  description: string; // shown verbatim in resolver prompt — must be imperative and unambiguous
  source: ArgSource;
  required: boolean;
  stateKeys?: string[]; // source="state" only — checked in order, first non-null wins
};

export type IToolExecutionResult = {
  success: boolean;
  message?: string;
  data?: Record<string, unknown>;
  emitEventKey?: string; // drives TransitionDefinition.onEvent selection
  cost?: number;
  // Classifies why a non-success result occurred:
  // "skip"      — intentional no-op (dedup, self-email, already processed) — silent, no retry
  // "arg_error" — resolver provided bad/missing args — no retry, logged as warning only
  // "tool_error"— API/network/business logic failure — logged to _tool-failures.jsonl
  failureKind?: "skip" | "arg_error" | "tool_error";
};

export type LLMToolChoice = {
  toolKey: string;
  args: Record<string, unknown>;
  inputTokens: number;
  outputTokens: number;
};

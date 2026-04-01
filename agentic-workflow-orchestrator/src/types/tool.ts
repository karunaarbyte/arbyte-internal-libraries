// ─────────────────────────────────────────────────────────────
// Tool types — shared contract between ToolAction implementations
// and the LLMActionResolver.
// ─────────────────────────────────────────────────────────────

export type IToolExecutionResult = {
  success: boolean;
  message?: string;
  data?: Record<string, unknown>;
  emitEventKey?: string; // drives TransitionDefinition.onEvent selection
  cost?: number;
};

export type LLMToolChoice = {
  toolKey: string;
  args: Record<string, unknown>;
};

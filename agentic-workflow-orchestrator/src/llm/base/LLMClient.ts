// ─────────────────────────────────────────────────────────────
// ILLMClient — provider-agnostic interface for all LLM calls.
//
// Two use cases in this system:
//   1. parseSkill   — natural language skill file → WorkflowDefinition JSON
//   2. resolveStep  — narrow tool list + state → LLMToolChoice
//
// Both require structured JSON output. Each provider implements
// complete() using their own mechanism (tool_use, response_format,
// response_schema, etc.) and returns a parsed object of type T.
// ─────────────────────────────────────────────────────────────

export type LLMMessage = {
  role: "user" | "assistant";
  content: string;
};

export type LLMRequest = {
  systemPrompt: string;
  messages: LLMMessage[];
  // Hint to the provider that the response must be valid JSON
  jsonMode: true;
  temperature?: number;
};

export type LLMResponse<T> = {
  data: T;
  // Token usage for cost tracking
  inputTokens: number;
  outputTokens: number;
};

export interface ILLMClient {
  complete<T>(request: LLMRequest): Promise<LLMResponse<T>>;
}

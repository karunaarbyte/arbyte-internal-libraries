import Anthropic from "@anthropic-ai/sdk";
import type { ILLMClient, LLMRequest, LLMResponse } from "../base";

// ─────────────────────────────────────────────────────────────
// ClaudeClient — Anthropic provider implementation.
//
// Uses prefill trick to force JSON output: the assistant turn
// is pre-filled with "{" so Claude always returns valid JSON.
// ─────────────────────────────────────────────────────────────

export type ClaudeModel =
  | "claude-opus-4-6"
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5-20251001";

export type ClaudeClientOptions = {
  model: ClaudeModel;
  maxTokens?: number;
};

export class ClaudeClient implements ILLMClient {
  private readonly _client: Anthropic;
  private readonly _model: ClaudeModel;
  private readonly _maxTokens: number;

  constructor(options: ClaudeClientOptions) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

    this._client = new Anthropic({ apiKey });
    this._model = options.model;
    this._maxTokens = options.maxTokens ?? 4096;
  }

  async complete<T>(request: LLMRequest): Promise<LLMResponse<T>> {
    const response = await this._client.messages.create({
      model: this._model,
      max_tokens: this._maxTokens,
      system: request.systemPrompt,
      messages: [
        ...request.messages.map((m) => ({ role: m.role, content: m.content })),
        // Prefill forces JSON output
        { role: "assistant", content: "{" },
      ],
    });

    const rawText =
      "{" + (response.content[0] as { type: string; text: string }).text;

    return {
      data: JSON.parse(rawText) as T,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}

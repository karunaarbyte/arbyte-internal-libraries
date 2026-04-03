import OpenAI from "openai";
import type { ILLMClient, LLMRequest, LLMResponse } from "../base";

// ─────────────────────────────────────────────────────────────
// OpenAIClient — OpenAI provider implementation.
//
// Uses response_format: { type: "json_object" } to enforce
// structured JSON output.
// ─────────────────────────────────────────────────────────────

export type OpenAIModel =
  | "gpt-4o"
  | "gpt-4o-mini"
  | "gpt-4-turbo"
  | "gpt-3.5-turbo";

export type OpenAIClientOptions = {
  model: OpenAIModel;
  maxTokens?: number;
  temperature?: number;
};

export class OpenAIClient implements ILLMClient {
  private readonly _client: OpenAI;
  private readonly _model: OpenAIModel;
  private readonly _maxTokens: number;
  private readonly _temperature?: number;

  constructor(options: OpenAIClientOptions) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

    this._client = new OpenAI({ apiKey });
    this._model = options.model;
    this._maxTokens = options.maxTokens ?? 4096;
    this._temperature = options.temperature;
  }

  async complete<T>(request: LLMRequest): Promise<LLMResponse<T>> {
    const response = await this._client.chat.completions.create({
      model: this._model,
      max_tokens: this._maxTokens,
      temperature: request.temperature ?? this._temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: request.systemPrompt },
        ...request.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    });

    const rawText = response.choices[0]?.message?.content ?? "{}";

    return {
      data: JSON.parse(rawText) as T,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };
  }
}

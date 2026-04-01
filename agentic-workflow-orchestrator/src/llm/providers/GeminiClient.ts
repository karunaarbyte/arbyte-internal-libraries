import { GoogleGenAI } from "@google/genai";
import type { ILLMClient, LLMRequest, LLMResponse } from "../base";

// ─────────────────────────────────────────────────────────────
// GeminiClient — Google Gemini provider implementation.
//
// Uses responseMimeType: "application/json" to enforce
// structured JSON output.
// ─────────────────────────────────────────────────────────────

export type GeminiModel =
  | "gemini-2.0-flash"
  | "gemini-2.0-flash-lite"
  | "gemini-1.5-pro"
  | "gemini-1.5-flash";

export type GeminiClientOptions = {
  model: GeminiModel;
  maxTokens?: number;
};

export class GeminiClient implements ILLMClient {
  private readonly _client: GoogleGenAI;
  private readonly _model: GeminiModel;
  private readonly _maxTokens: number;

  constructor(options: GeminiClientOptions) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

    this._client = new GoogleGenAI({ apiKey });
    this._model = options.model;
    this._maxTokens = options.maxTokens ?? 4096;
  }

  async complete<T>(request: LLMRequest): Promise<LLMResponse<T>> {
    // Combine system prompt + user messages into a single contents array
    const contents = request.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const response = await this._client.models.generateContent({
      model: this._model,
      config: {
        systemInstruction: request.systemPrompt,
        maxOutputTokens: this._maxTokens,
        responseMimeType: "application/json",
      },
      contents,
    });

    const rawText = response.text ?? "{}";

    return {
      data: JSON.parse(rawText) as T,
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }
}

import type { IState } from "fsm-orchestrator";
import type { ILLMClient } from "./base";
import type { ToolAction } from "../tools/base";
import type { LLMToolChoice } from "../types";
import { STEP_RESOLVER_PROMPT } from "./prompts/step-resolver.prompt";

// ─────────────────────────────────────────────────────────────
// LLMActionResolver — resolves which tool to call at a given step.
//
// Receives the narrow list of candidate tools (already filtered
// to what's allowed at this step), calls the LLM once, and
// returns the chosen tool key + args.
// ─────────────────────────────────────────────────────────────

export type ResolveStepInput = {
  stepDescription: string;
  state: IState;
  eventPayload: Record<string, unknown>;
  candidateTools: ToolAction[];
};

export class LLMActionResolver {
  private readonly _client: ILLMClient;

  constructor(client: ILLMClient) {
    this._client = client;
  }

  async resolve(input: ResolveStepInput): Promise<LLMToolChoice> {
    const { stepDescription, state, eventPayload, candidateTools } = input;

    if (candidateTools.length === 0) {
      throw new Error(
        `[LLMActionResolver] No candidate tools available for step: "${state.key}"`
      );
    }

    // If only one tool is available, skip the LLM call entirely
    if (candidateTools.length === 1) {
      return { toolKey: candidateTools[0].key, args: {} };
    }

    const toolList = candidateTools
      .map((t) => `- ${t.key}: ${t.description}`)
      .join("\n");

    const userPrompt = `
Step: ${stepDescription}

Current state:
${JSON.stringify(state.data, null, 2)}

Event payload:
${JSON.stringify(eventPayload, null, 2)}

Available tools:
${toolList}
    `.trim();

    const response = await this._client.complete<LLMToolChoice>({
      systemPrompt: STEP_RESOLVER_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      jsonMode: true,
    });

    const { toolKey, args } = response.data;

    const isValid = candidateTools.some((t) => t.key === toolKey);
    if (!isValid) {
      throw new Error(
        `[LLMActionResolver] LLM returned unknown tool key: "${toolKey}". ` +
          `Valid keys: ${candidateTools.map((t) => t.key).join(", ")}`
      );
    }

    return { toolKey, args };
  }
}

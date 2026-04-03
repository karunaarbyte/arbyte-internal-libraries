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
  candidateTools: ToolAction[];
};

// Fields that are internal bookkeeping — not useful for tool selection, hidden from LLM
const STRIP_FIELDS = new Set([
  "task_id", "ts", "sent_at", "approval_pending", "replied_to",
  "history_id", "approved_at",
]);

// Tools that need the full incoming email body to do their job correctly.
// gmail.reply and gmail.send read the body from state.data directly (via fromState),
// so the resolver only needs enough to pick the tool — not the full content.
const FULL_BODY_TOOLS = new Set([
  "core.draft_text",
]);

const BODY_TRUNCATE_SHORT = 300;  // for tools that don't need the full email
const BODY_TRUNCATE_FULL  = 6000; // for drafting/reply tools — covers large code blocks
const DEFAULT_TRUNCATE_LENGTH = 800;

function buildStateContext(
  data: Record<string, unknown>,
  candidateToolKeys: string[]
): Record<string, unknown> {
  const needsFullBody = candidateToolKeys.some((k) => FULL_BODY_TOOLS.has(k));
  const bodyLimit = needsFullBody ? BODY_TRUNCATE_FULL : BODY_TRUNCATE_SHORT;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (STRIP_FIELDS.has(k)) continue;
    if (typeof v === "string") {
      const limit = (k === "body" || k === "content") ? bodyLimit : DEFAULT_TRUNCATE_LENGTH;
      out[k] = v.length > limit ? v.slice(0, limit) + "…[truncated]" : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export class LLMActionResolver {
  private readonly _client: ILLMClient;

  constructor(client: ILLMClient) {
    this._client = client;
  }

  async resolve(input: ResolveStepInput): Promise<LLMToolChoice> {
    const { stepDescription, state, candidateTools } = input;

    if (candidateTools.length === 0) {
      throw new Error(
        `[LLMActionResolver] No candidate tools available for step: "${state.key}"`
      );
    }

    // If only one tool is available, still call LLM to resolve args
    // (skipping would pass empty args, causing required-field failures)

    const toolList = candidateTools
      .map((t) => `- ${t.key}: ${t.description}`)
      .join("\n");

    const stateContext = buildStateContext(
      state.data as Record<string, unknown>,
      candidateTools.map((t) => t.key)
    );

    const userPrompt = `
Step: ${stepDescription}

Current state:
${JSON.stringify(stateContext, null, 2)}

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

    return { toolKey, args, inputTokens: response.inputTokens, outputTokens: response.outputTokens };
  }
}

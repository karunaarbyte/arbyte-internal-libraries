import type { IState } from "fsm-orchestrator";
import type { ILLMClient } from "./base";
import type { ToolAction } from "../tools/base";
import type { LLMToolChoice } from "../types";
import { STEP_RESOLVER_PROMPT } from "./prompts/step-resolver.prompt";
import { STEP_ARGS_PROMPT } from "./prompts/step-args.prompt";

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

// Build a tool description block for the resolver prompt.
// When inputSchema is declared, renders a structured contract with explicit arg sources.
// Falls back to the description string for tools without a schema.
function buildToolBlock(tool: ToolAction): string {
  if (!tool.inputSchema || tool.inputSchema.length === 0) {
    return `${tool.key}: ${tool.description}`;
  }

  const argLines = tool.inputSchema.map((def) => {
    const req = def.required ? "required" : "optional";
    let source: string;
    if (def.source === "state") {
      const keys = def.stateKeys ?? [def.name];
      source = `from state.data.${keys.join(" or state.data.")}`;
    } else if (def.source === "params") {
      source = "from step params (compile-time constant — do not generate)";
    } else {
      source = "generate from step description and state context";
    }
    return `    - ${def.name} (${req}, ${source}): ${def.description}`;
  });

  const outputLine = tool.outputFields && tool.outputFields.length > 0
    ? `\n  Writes to state: ${tool.outputFields.join(", ")}`
    : "";

  return `${tool.key}\n  Inputs:\n${argLines.join("\n")}${outputLine}`;
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

    const stateContext = buildStateContext(
      state.data as Record<string, unknown>,
      candidateTools.map((t) => t.key)
    );

    // Fast path: tool is already known — only ask LLM for args.
    // Saves ~40% tokens vs the full resolver prompt (no tool list, no selection logic).
    if (candidateTools.length === 1) {
      return this._resolveArgs(stepDescription, stateContext, candidateTools[0]!);
    }

    const toolList = candidateTools
      .map((t) => buildToolBlock(t))
      .join("\n\n");

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

  private async _resolveArgs(
    stepDescription: string,
    stateContext: Record<string, unknown>,
    tool: ToolAction
  ): Promise<LLMToolChoice> {
    const userPrompt = `
Step: ${stepDescription}

Current state:
${JSON.stringify(stateContext, null, 2)}

Tool:
${buildToolBlock(tool)}
    `.trim();

    const response = await this._client.complete<{ args: Record<string, unknown> }>({
      systemPrompt: STEP_ARGS_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      jsonMode: true,
    });

    return {
      toolKey: tool.key,
      args: response.data.args ?? {},
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    };
  }
}

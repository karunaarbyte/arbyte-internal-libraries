import type { ILLMClient } from "../llm/base";
import { buildSkillCompilerPrompt } from "../llm/prompts/skill-compiler.prompt";
import type { IToolRegistry } from "../tools/registry";
import type { WorkflowDefinition } from "../types";

// ─────────────────────────────────────────────────────────────
// LLMSkillParser — parses a natural language skill file into
// a WorkflowDefinition JSON via a single LLM call.
//
// Single responsibility: NL text in, WorkflowDefinition out.
// Does not handle versioning or storage.
// ─────────────────────────────────────────────────────────────

export class LLMSkillParser {
  private readonly _client: ILLMClient;
  private readonly _registry: IToolRegistry;

  constructor(client: ILLMClient, registry: IToolRegistry) {
    this._client = client;
    this._registry = registry;
  }

  async parse(skillFileContent: string): Promise<WorkflowDefinition> {
    const availableToolKeys = this._registry.getAll().map((t) => t.key);

    const response = await this._client.complete<WorkflowDefinition>({
      systemPrompt: buildSkillCompilerPrompt(availableToolKeys),
      messages: [{ role: "user", content: skillFileContent }],
      jsonMode: true,
    });

    this._validate(response.data);

    return response.data;
  }

  private _validate(def: WorkflowDefinition): void {
    if (!def.id) throw new Error("[LLMSkillParser] Missing field: id");
    if (!def.trigger) throw new Error("[LLMSkillParser] Missing field: trigger");
    if (!Array.isArray(def.steps) || def.steps.length === 0)
      throw new Error("[LLMSkillParser] steps must be a non-empty array");
    if (!def.initialStep)
      throw new Error("[LLMSkillParser] Missing field: initialStep");

    const stepKeys = new Set(def.steps.map((s) => s.key));

    if (!stepKeys.has(def.initialStep))
      throw new Error(
        `[LLMSkillParser] initialStep "${def.initialStep}" does not match any step key`
      );

    const registeredToolKeys = new Set(this._registry.getAll().map((t) => t.key));

    for (const step of def.steps) {
      if (!step.key) throw new Error("[LLMSkillParser] Step missing key");
      if (!Array.isArray(step.transitions))
        throw new Error(`[LLMSkillParser] Step "${step.key}" missing transitions`);

      if (!Array.isArray(step.allowedTools))
        throw new Error(`[LLMSkillParser] Step "${step.key}" allowedTools must be an array`);

      for (const toolKey of step.allowedTools) {
        if (!registeredToolKeys.has(toolKey))
          throw new Error(
            `[LLMSkillParser] Step "${step.key}" references unknown tool: "${toolKey}"`
          );
      }

      for (const transition of step.transitions) {
        if (transition.nextStep !== "end" && !stepKeys.has(transition.nextStep))
          throw new Error(
            `[LLMSkillParser] Step "${step.key}" transition points to unknown step: "${transition.nextStep}"`
          );
      }
    }
  }
}

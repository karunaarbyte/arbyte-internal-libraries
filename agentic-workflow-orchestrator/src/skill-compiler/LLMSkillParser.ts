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

  // Canonical event keys emitted by webhook routes
  private static readonly TRIGGER_EVENT_KEYS = [
    "gmail.email_received",
    "slack.message",
    "slack.app_mention",
    "slack.approval_granted",
    "slack.approval_rejected",
    "drive.file_changed",
    "manual_trigger",
  ];

  async parse(skillFileContent: string, stableFileId?: string): Promise<WorkflowDefinition | null> {
    const toolSummaries = this._registry.getAll().map((t) => ({
      key: t.key,
      outputFields: t.outputFields,
    }));

    const response = await this._client.complete<WorkflowDefinition & { error?: string }>({
      systemPrompt: buildSkillCompilerPrompt(toolSummaries, LLMSkillParser.TRIGGER_EVENT_KEYS, stableFileId),
      messages: [{ role: "user", content: skillFileContent }],
      jsonMode: true,
    });

    if (response.data.error === "not_a_skill_file") {
      console.warn("[LLMSkillParser] File is not a workflow skill description — skipping");
      return null;
    }

    const def = response.data;
    if (Array.isArray(def.steps)) {
      for (const step of def.steps) {
        if (!Array.isArray(step.allowedTools)) step.allowedTools = [];
        // core.draft_text always requires LLM-generated args — strip toolKey if compiler emitted it
        if (step.toolKey === "core.draft_text") step.toolKey = undefined;
        // Ensure params is a plain object or absent
        if (step.params !== undefined && (typeof step.params !== "object" || Array.isArray(step.params)))
          step.params = undefined;
        if (!Array.isArray(step.reads)) step.reads = undefined;
        if (!Array.isArray(step.writes)) step.writes = undefined;

        // Do not auto-infer transitions — missing or wrong transitions must fail validation.
        // Auto-inference silently wires the wrong control flow for branching or externally-gated steps.
      }
    }

    try {
      this._validate(def);
    } catch (err) {
      console.error("[LLMSkillParser] Validation failed:", err instanceof Error ? err.message : err);
      console.error("[LLMSkillParser] LLM output was:", JSON.stringify(def, null, 2));
      return null;
    }

    return def;
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
      if (!Array.isArray(step.transitions) || step.transitions.length === 0)
        throw new Error(`[LLMSkillParser] Step "${step.key}" has no transitions — every step must declare at least one`);

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

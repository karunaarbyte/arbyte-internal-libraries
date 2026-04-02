import type { LLMSkillParser } from "./LLMSkillParser";
import type { IWorkflowDefinitionStore } from "../persistence/WorkflowDefinitionStore";
import type { WorkflowDefinitionVersion } from "../types";

// ─────────────────────────────────────────────────────────────
// SkillCompiler — orchestrates the full compilation pipeline.
//
// Receives raw skill file content, calls LLMSkillParser,
// wraps the result in a versioned envelope, persists it,
// then notifies the orchestrator to reload the workflow.
// ─────────────────────────────────────────────────────────────

export type ReloadCallback = (workflowId: string) => Promise<void>;

export class SkillCompiler {
  private readonly _parser: LLMSkillParser;
  private readonly _store: IWorkflowDefinitionStore;
  private readonly _onReload: ReloadCallback;

  constructor(
    parser: LLMSkillParser,
    store: IWorkflowDefinitionStore,
    onReload: ReloadCallback
  ) {
    this._parser = parser;
    this._store = store;
    this._onReload = onReload;
  }

  async compile(skillFileContent: string): Promise<WorkflowDefinitionVersion | null> {
    const definition = await this._parser.parse(skillFileContent);
    if (!definition) return null;

    const existing = await this._store.getAll(definition.id);
    const nextVersion = existing.length > 0
      ? Math.max(...existing.map((v) => v.version)) + 1
      : 1;

    const newVersion: WorkflowDefinitionVersion = {
      version: nextVersion,
      status: "active",
      compiledAt: new Date().toISOString(),
      definition,
    };

    await this._store.save(newVersion);
    await this._store.promoteVersion(definition.id, nextVersion);

    console.log(
      `[SkillCompiler] Compiled workflow "${definition.id}" → version ${nextVersion} (active)`
    );

    await this._onReload(definition.id);

    return newVersion;
  }
}

import { Orchestrator } from "fsm-orchestrator";
import type { ITask } from "fsm-orchestrator";
import type { IInvocationLog } from "fsm-orchestrator/src/types/logs";
import type { IWorkflowDefinitionStore } from "../persistence/WorkflowDefinitionStore";
import type { ITaskStateStore } from "../persistence/TaskStateStore";
import type { IInvocationLogStore } from "../persistence/InvocationLogStore";
import type { WorkflowFactory } from "../workflow-factory/WorkflowFactory";

// ─────────────────────────────────────────────────────────────
// AgenticOrchestrator — extends the abstract FSM Orchestrator.
//
// Responsibilities beyond the base class:
//   - Delegates persistTaskState / persistInvocationLog to stores
//   - reloadWorkflow: fetches active WorkflowDefinition, rebuilds
//     the FSM Workflow via WorkflowFactory, and re-registers it.
//     Called by SkillCompiler after a new skill version is compiled.
//     In-flight tasks are NOT affected — they continue on the old
//     workflow object already held in memory.
// ─────────────────────────────────────────────────────────────

export class AgenticOrchestrator extends Orchestrator {
  private readonly _definitionStore: IWorkflowDefinitionStore;
  private readonly _taskStore: ITaskStateStore;
  private readonly _logStore: IInvocationLogStore;
  private readonly _factory: WorkflowFactory;

  constructor(
    definitionStore: IWorkflowDefinitionStore,
    taskStore: ITaskStateStore,
    logStore: IInvocationLogStore,
    factory: WorkflowFactory
  ) {
    super("agentic-orchestrator");
    this._definitionStore = definitionStore;
    this._taskStore = taskStore;
    this._logStore = logStore;
    this._factory = factory;
  }

  // ── FSM abstract method implementations ──────────────────

  protected persistTaskState(task: ITask): void {
    this._taskStore.save(task).catch((err) =>
      console.error(`[AgenticOrchestrator] Failed to persist task "${task.id}":`, err)
    );
  }

  protected persistInvocationLog(log: IInvocationLog): void {
    this._logStore.append(log).catch((err) =>
      console.error(`[AgenticOrchestrator] Failed to persist log for task "${log.task_id}":`, err)
    );
  }

  // ── Workflow reload ───────────────────────────────────────

  async reloadWorkflow(workflowId: string): Promise<void> {
    const active = await this._definitionStore.getActive(workflowId);
    if (!active) {
      console.warn(
        `[AgenticOrchestrator] No active definition found for workflow "${workflowId}" — skipping reload`
      );
      return;
    }

    const workflow = this._factory.build(active.definition);

    const existingIndex = this.getWorkflows().findIndex((w) => w.key === workflowId);
    if (existingIndex >= 0) {
      this.workflows[existingIndex] = workflow;
      console.log(
        `[AgenticOrchestrator] Reloaded workflow "${workflowId}" (version ${active.version})`
      );
    } else {
      this.registerWorkflow(workflow);
      console.log(
        `[AgenticOrchestrator] Registered new workflow "${workflowId}" (version ${active.version})`
      );
    }
  }

  // ── Boot helper ───────────────────────────────────────────

  async loadAllWorkflows(): Promise<void> {
    const ids = await this._definitionStore.getAllWorkflowIds();
    const results = await Promise.allSettled(ids.map((id) => this.reloadWorkflow(id)));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0)
      console.warn(`[AgenticOrchestrator] ${failed}/${ids.length} workflow(s) failed to load`);
    console.log(`[AgenticOrchestrator] Loaded ${ids.length - failed}/${ids.length} workflow(s) from store`);
  }
}

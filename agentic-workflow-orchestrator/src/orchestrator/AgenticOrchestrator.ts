import { Orchestrator, Workflow } from "fsm-orchestrator";
import type { ITask, IEvent } from "fsm-orchestrator";
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

  // Per-task isolated Workflow instances — prevents shared state corruption
  // when multiple tasks run concurrently on the same workflow type.
  private readonly _taskWorkflows = new Map<string, Workflow>();
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

  // ── Task init — injects task_id into state.data ──────────
  // Required so slack.send_approval_request can embed task_id
  // in the button value and the interactions route can resume
  // the correct task on button click.

  public initTask(workflowKey: string, initialData?: Record<string, unknown>): ITask {
    const task = super.initTask(workflowKey, initialData);
    // Inject task_id into state.data so all steps have it available.
    // slack.send_approval_request embeds it in the button value so the
    // interactions route can resume the correct task on button click.
    task.state = { ...task.state, data: { ...task.state.data, task_id: task.id } };
    return task;
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

  // ── Isolated handleEvent ─────────────────────────────────
  // Overrides the base class to give each task its own Workflow
  // instance, preventing concurrent tasks from corrupting each
  // other's state on the shared workflow object.

  public async handleEvent(taskId: string, event: IEvent): Promise<IInvocationLog[]> {
    const task = this.getTask(taskId);
    if (!task) {
      return [{
        success: false,
        message: `Task '${taskId}' not found`,
        task_id: taskId,
        event,
        timestamp: new Date().toISOString(),
      }];
    }

    // Get or build a dedicated Workflow instance for this task
    let taskWorkflow = this._taskWorkflows.get(taskId);
    if (!taskWorkflow) {
      const active = await this._definitionStore.getActive(task.workflowKey);
      if (!active) {
        return [{
          success: false,
          message: `No active definition for workflow '${task.workflowKey}'`,
          task_id: taskId,
          event,
          timestamp: new Date().toISOString(),
        }];
      }
      taskWorkflow = this._factory.build(active.definition);
      this._taskWorkflows.set(taskId, taskWorkflow);
    }

    // Merge event payload into state so steps can access trigger data (e.g. approved_by)
    const stateWithPayload = event.payload && Object.keys(event.payload).length > 0
      ? { ...task.state, data: { ...task.state.data, ...event.payload } }
      : task.state;
    taskWorkflow.setState(stateWithPayload);
    const result = await taskWorkflow.handleEvent(event, this.messenger);

    if (result.success) {
      task.state = result.new_state ?? task.state;
      this.persistTaskState(task);
    }

    const invocationLog: IInvocationLog = {
      action_log_data: result,
      task_id: task.id,
      event,
      success: result.success,
      timestamp: new Date().toISOString(),
    };
    this.logs.push(invocationLog);
    this.persistInvocationLog(invocationLog);

    // Auto-chain to next step
    if (result.success && result.emitEvent) {
      const nextEvent: IEvent = {
        key: result.emitEvent.key,
        payload: result.emitEvent.buildPayload?.(result) ?? {},
      };
      await this.handleEvent(task.id, nextEvent);
    }

    // Free the isolated workflow once the task reaches end state
    if (task.state.key === "end") {
      this._taskWorkflows.delete(taskId);
    }

    return [invocationLog];
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

    // Evict cached per-task workflow instances for this workflow so that the next
    // event on any task picks up the new definition from the store.
    for (const task of this.getTasks()) {
      if (task.workflowKey === workflowId) {
        this._taskWorkflows.delete(task.id);
      }
    }
  }

  // Returns workflow keys whose active definition triggers on the given eventKey
  async getWorkflowKeysByTrigger(eventKey: string): Promise<string[]> {
    const ids = await this._definitionStore.getAllWorkflowIds();
    const results = await Promise.all(
      ids.map(async (id) => {
        const active = await this._definitionStore.getActive(id);
        return active?.definition.trigger.eventKey === eventKey ? id : null;
      })
    );
    return results.filter((id): id is string => id !== null);
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

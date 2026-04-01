import type { ITask } from "fsm-orchestrator";

// ─────────────────────────────────────────────────────────────
// TaskStateStore — in-memory store for active task states.
//
// Skeleton implementation. Replace with a database-backed store
// for production. The in-memory map is sufficient for dev/testing.
// ─────────────────────────────────────────────────────────────

export interface ITaskStateStore {
  save(task: ITask): Promise<void>;
  get(taskId: string): Promise<ITask | undefined>;
  getByWorkflow(workflowId: string): Promise<ITask[]>;
  getAll(): Promise<ITask[]>;
}

export class TaskStateStore implements ITaskStateStore {
  private readonly _tasks = new Map<string, ITask>();

  async save(task: ITask): Promise<void> {
    this._tasks.set(task.id, { ...task });
  }

  async get(taskId: string): Promise<ITask | undefined> {
    return this._tasks.get(taskId);
  }

  async getByWorkflow(workflowId: string): Promise<ITask[]> {
    return Array.from(this._tasks.values()).filter(
      (t) => t.workflowKey === workflowId
    );
  }

  async getAll(): Promise<ITask[]> {
    return Array.from(this._tasks.values());
  }
}

import type { IInvocationLog } from "fsm-orchestrator/src/types/logs";

// ─────────────────────────────────────────────────────────────
// InvocationLogStore — in-memory store for invocation audit logs.
//
// Skeleton implementation. Replace with a database-backed store
// for production.
// ─────────────────────────────────────────────────────────────

export type { IInvocationLog };

export interface IInvocationLogStore {
  append(log: IInvocationLog): Promise<void>;
  getByTask(taskId: string): Promise<IInvocationLog[]>;
  getAll(): Promise<IInvocationLog[]>;
}

export class InvocationLogStore implements IInvocationLogStore {
  private readonly _logs: IInvocationLog[] = [];

  async append(log: IInvocationLog): Promise<void> {
    this._logs.push(log);
  }

  async getByTask(taskId: string): Promise<IInvocationLog[]> {
    return this._logs.filter((l) => l.task_id === taskId);
  }

  async getAll(): Promise<IInvocationLog[]> {
    return [...this._logs];
  }
}

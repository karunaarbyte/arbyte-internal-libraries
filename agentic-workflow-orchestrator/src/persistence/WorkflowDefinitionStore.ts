import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { WorkflowDefinitionVersion } from "../types";

// ─────────────────────────────────────────────────────────────
// WorkflowDefinitionStore — versioned file-based storage for
// compiled WorkflowDefinitions.
//
// One JSON file per workflowId under storageDir/.
// Invariant: at most one version per workflowId may be "active".
// ─────────────────────────────────────────────────────────────

export interface IWorkflowDefinitionStore {
  save(envelope: WorkflowDefinitionVersion): Promise<void>;
  getActive(workflowId: string): Promise<WorkflowDefinitionVersion | undefined>;
  getAll(workflowId: string): Promise<WorkflowDefinitionVersion[]>;
  promoteVersion(workflowId: string, version: number): Promise<void>;
  getAllWorkflowIds(): Promise<string[]>;
}

export class WorkflowDefinitionStore implements IWorkflowDefinitionStore {
  private readonly _dir: string;

  constructor(storageDir: string) {
    this._dir = storageDir;
    if (!existsSync(this._dir)) {
      mkdirSync(this._dir, { recursive: true });
    }
  }

  async save(envelope: WorkflowDefinitionVersion): Promise<void> {
    const versions = await this.getAll(envelope.definition.id);
    const existing = versions.findIndex((v) => v.version === envelope.version);

    if (existing >= 0) {
      versions[existing] = envelope;
    } else {
      versions.push(envelope);
    }

    this._write(envelope.definition.id, versions);
  }

  async getActive(
    workflowId: string
  ): Promise<WorkflowDefinitionVersion | undefined> {
    const versions = await this.getAll(workflowId);
    return versions.find((v) => v.status === "active");
  }

  async getAll(workflowId: string): Promise<WorkflowDefinitionVersion[]> {
    return this._read(workflowId);
  }

  async getAllWorkflowIds(): Promise<string[]> {
    if (!existsSync(this._dir)) return [];
    const { readdirSync } = await import("fs");
    return readdirSync(this._dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(".json", ""));
  }

  // Promotes the given version to "active", demotes all others to "backup".
  async promoteVersion(workflowId: string, version: number): Promise<void> {
    const versions = await this.getAll(workflowId);

    const target = versions.find((v) => v.version === version);
    if (!target) {
      throw new Error(
        `[WorkflowDefinitionStore] Version ${version} not found for workflow "${workflowId}"`
      );
    }

    const updated = versions.map((v) => ({
      ...v,
      status:
        v.version === version
          ? ("active" as const)
          : ("backup" as const),
    }));

    this._write(workflowId, updated);
  }

  // ── File I/O ─────────────────────────────────────────────

  private _filePath(workflowId: string): string {
    return join(this._dir, `${workflowId}.json`);
  }

  private _read(workflowId: string): WorkflowDefinitionVersion[] {
    const path = this._filePath(workflowId);
    if (!existsSync(path)) return [];
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as WorkflowDefinitionVersion[];
    } catch {
      console.error(`[WorkflowDefinitionStore] Failed to parse "${path}" — returning empty`);
      return [];
    }
  }

  private _write(workflowId: string, versions: WorkflowDefinitionVersion[]): void {
    writeFileSync(this._filePath(workflowId), JSON.stringify(versions, null, 2), "utf-8");
  }
}

import type { ToolAction } from "../base";

// ─────────────────────────────────────────────────────────────
// ToolRegistry — maps tool keys to ToolAction instances.
//
// Populated once at app startup. Consumed by:
//   - WorkflowFactory  (validates allowedTools in StepDefinitions)
//   - LLMActionResolver (retrieves narrow tool list per step)
// ─────────────────────────────────────────────────────────────

export interface IToolRegistry {
  register(tool: ToolAction): void;
  get(key: string): ToolAction | undefined;
  getAll(): ToolAction[];
  getByKeys(keys: string[]): ToolAction[];
}

export class ToolRegistry implements IToolRegistry {
  private readonly _tools = new Map<string, ToolAction>();

  register(tool: ToolAction): void {
    if (this._tools.has(tool.key)) {
      throw new Error(`Tool already registered: "${tool.key}"`);
    }
    this._tools.set(tool.key, tool);
  }

  get(key: string): ToolAction | undefined {
    return this._tools.get(key);
  }

  getAll(): ToolAction[] {
    return Array.from(this._tools.values());
  }

  getByKeys(keys: string[]): ToolAction[] {
    return keys.flatMap((key) => {
      const tool = this._tools.get(key);
      if (!tool) {
        console.warn(`[ToolRegistry] Unknown tool key requested: "${key}"`);
        return [];
      }
      return [tool];
    });
  }
}

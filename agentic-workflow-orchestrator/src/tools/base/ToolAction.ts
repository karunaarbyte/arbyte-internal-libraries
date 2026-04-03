import { Action } from "fsm-orchestrator";
import type { IState } from "fsm-orchestrator";
import type { ArgDef, IToolExecutionResult } from "../../types";

// ─────────────────────────────────────────────────────────────
// ToolAction — abstract base for all tool implementations.
//
// Action (fsm-orchestrator) uses constructor-injected functions,
// not inheritance. ToolAction wraps that pattern: subclasses
// implement execute(), and toAction() produces the FSM-compatible
// Action instance with the correct canBeInvoked closure baked in.
// ─────────────────────────────────────────────────────────────

export abstract class ToolAction {
  abstract readonly key: string;

  // Sent verbatim to the LLM for tool selection — be precise.
  abstract readonly description: string;

  // Structured input contract. When declared, pre-execution validation runs before any API call.
  // source="state": value read from state.data (use stateKeys for fromState multi-key fallback).
  // source="llm":   resolver must generate this value.
  // source="params": provided at compile time via StepDefinition.params.
  readonly inputSchema?: ArgDef[];

  // State keys this tool writes to state.data on success.
  // Used by the skill compiler to populate step writes[] and generate accurate outputFields in prompt.
  // Use "<draft_key>" as a sentinel when the key is dynamic (e.g. core.draft_text).
  readonly outputFields?: string[];

  // The actual tool work. Subclasses implement this.
  abstract execute(
    args: Record<string, unknown>,
    state: IState
  ): Promise<IToolExecutionResult>;

  // Produces an FSM Action for use inside a LLMStepAction.
  // canBeInvoked returns true only when the current state key
  // is one of the steps this tool is allowed at.
  toAction(allowedAtStepKeys: Set<string>): Action {
    return new Action(
      this.key,
      this.description,
      (state: IState) => ({
        can: allowedAtStepKeys.has(state.key),
        description: this.description,
      }),
      async (state: IState) => {
        const result = await this.execute({}, state);
        return {
          success: result.success,
          message: result.message,
          data: result.data as Record<string, any> | undefined,
          cost: result.cost ?? 0,
        };
      }
    );
  }
}

import { Action } from "fsm-orchestrator";
import type { IState } from "fsm-orchestrator";
import type { IActionLogData } from "fsm-orchestrator/src/types/logs";
import type { StepDefinition, TransitionDefinition, TransitionCondition, IToolExecutionResult } from "../types";
import type { IToolRegistry } from "../tools/registry";
import type { LLMActionResolver } from "../llm/LLMActionResolver";

// ─────────────────────────────────────────────────────────────
// LLMStepAction — produces an FSM Action for a single workflow step.
//
// Branching constraint: Action.invoke() always overwrites result.emitEvent
// with this.emitEvent (set at construction), so we cannot emit different
// event keys per branch from inside _invoke.
//
// Solution: each step emits a fixed "step.{key}.complete" event, but
// sets new_state.key to the chosen branch's step key. The next step's
// trigger condition (state.key === nextStepKey) acts as the branch selector.
// WorkflowFactory registers all possible next steps as triggers on this
// same event key, each with its own state.key condition.
// ─────────────────────────────────────────────────────────────

export const stepTriggerEvent = (stepKey: string): string =>
  `step.${stepKey}.complete`;

export class LLMStepAction {
  private readonly _stepDef: StepDefinition;
  private readonly _registry: IToolRegistry;
  private readonly _resolver: LLMActionResolver;

  constructor(
    stepDef: StepDefinition,
    registry: IToolRegistry,
    resolver: LLMActionResolver
  ) {
    this._stepDef = stepDef;
    this._registry = registry;
    this._resolver = resolver;
  }

  buildAction(): Action {
    const stepDef = this._stepDef;
    const isTerminal = stepDef.transitions.every((t) => t.nextStep === "end");

    return new Action(
      `step.${stepDef.key}`,
      stepDef.description,
      (state: IState) => ({
        can: state.key === stepDef.key,
        description: stepDef.description,
      }),
      (state: IState) => this._invoke(state),
      isTerminal
        ? undefined
        : {
            key: stepTriggerEvent(stepDef.key),
            buildPayload: (log: IActionLogData) => log.data ?? {},
          }
    );
  }

  private async _invoke(state: IState): Promise<IActionLogData> {
    const candidateTools = this._registry.getByKeys(this._stepDef.allowedTools);

    if (candidateTools.length === 0) {
      return {
        success: false,
        message: `[LLMStepAction] No tools registered for step "${this._stepDef.key}"`,
        cost: 0,
        new_state: state,
      };
    }

    const { toolKey, args } = await this._resolver.resolve({
      stepDescription: this._stepDef.description,
      state,
      eventPayload: state.data as Record<string, unknown>,
      candidateTools,
    });

    const tool = this._registry.get(toolKey);
    if (!tool) {
      return {
        success: false,
        message: `[LLMStepAction] Resolved tool "${toolKey}" not found in registry`,
        cost: 0,
        new_state: state,
      };
    }

    const toolResult = await tool.execute(args, state);

    if (!toolResult.success) {
      return {
        success: false,
        message: toolResult.message ?? `[LLMStepAction] Tool "${toolKey}" failed`,
        cost: toolResult.cost ?? 0,
        new_state: state,
      };
    }

    const transition = this._selectTransition(toolResult);
    const nextStateKey = transition.nextStep === "end" ? "end" : transition.nextStep;

    const newState: IState = {
      key: nextStateKey,
      data: { ...state.data, ...toolResult.data },
    };

    return {
      success: true,
      message: toolResult.message,
      data: toolResult.data as Record<string, any> | undefined,
      cost: toolResult.cost ?? 1,
      new_state: newState,
    };
  }

  private _selectTransition(result: IToolExecutionResult): TransitionDefinition {
    for (const transition of this._stepDef.transitions) {
      if (result.emitEventKey && transition.onEvent !== result.emitEventKey) continue;
      if (!transition.condition) return transition;
      if (this._evaluateCondition(transition.condition, result.data ?? {})) return transition;
    }

    console.warn(
      `[LLMStepAction] No transition matched for step "${this._stepDef.key}" — using first transition`
    );
    return this._stepDef.transitions[0];
  }

  private _evaluateCondition(
    condition: TransitionCondition,
    data: Record<string, unknown>
  ): boolean {
    const value = this._getNestedValue(data, condition.field);
    switch (condition.operator) {
      case "eq": return value === condition.value;
      case "neq": return value !== condition.value;
      case "exists": return value !== undefined && value !== null;
      case "not_exists": return value === undefined || value === null;
    }
  }

  private _getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    return path.split(".").reduce((acc: unknown, key) => {
      if (acc !== null && typeof acc === "object") {
        return (acc as Record<string, unknown>)[key];
      }
      return undefined;
    }, obj);
  }
}

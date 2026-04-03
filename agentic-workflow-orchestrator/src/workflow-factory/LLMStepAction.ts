import { Action } from "fsm-orchestrator";
import type { IState } from "fsm-orchestrator";
import type { IActionLogData } from "fsm-orchestrator/src/types/logs";
import type { StepDefinition, TransitionDefinition, TransitionCondition, IToolExecutionResult } from "../types";
import type { IToolRegistry } from "../tools/registry";
import type { LLMActionResolver } from "../llm/LLMActionResolver";
import type { UsageLogger } from "../persistence/UsageLogger";

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
  private readonly _workflowId: string;
  private readonly _registry: IToolRegistry;
  private readonly _resolver: LLMActionResolver;
  private readonly _usageLogger?: UsageLogger;

  constructor(
    stepDef: StepDefinition,
    workflowId: string,
    registry: IToolRegistry,
    resolver: LLMActionResolver,
    usageLogger?: UsageLogger
  ) {
    this._stepDef = stepDef;
    this._workflowId = workflowId;
    this._registry = registry;
    this._resolver = resolver;
    this._usageLogger = usageLogger;
  }

  // triggerFromStateKey: when this action is reached via an external event (e.g.
  // slack.approval_granted) from a different step, pass that source step's key so
  // canBeInvoked matches the state the task is actually in when the event arrives.
  buildAction(actionKey: string, triggerFromStateKey?: string): Action {
    const stepDef = this._stepDef;
    const isTerminal = stepDef.transitions.every((t) => t.nextStep === "end");
    const validStateKey = triggerFromStateKey ?? stepDef.key;

    return new Action(
      actionKey,
      stepDef.description,
      (state: IState) => ({
        can: state.key === validStateKey,
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

    const { toolKey, args, inputTokens, outputTokens } = await this._resolver.resolve({
      stepDescription: this._stepDef.description,
      state,
      candidateTools,
    });

    // Log tokens for every resolver call regardless of what happens next
    this._usageLogger?.append({
      timestamp: new Date().toISOString(),
      workflowId: this._workflowId,
      stepKey: this._stepDef.key,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
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

    const mergedData = { ...state.data, ...toolResult.data, task_id: state.data.task_id };

    // Externally-gated step: ALL transitions wait for external events (e.g. slack.approval_granted).
    // Do NOT pre-advance state — the task stays at the current step key so that when the
    // external event arrives, the correct transition branch (granted vs rejected) can fire.
    const isExternallyGated =
      this._stepDef.transitions.length > 0 &&
      this._stepDef.transitions.every((t) => t.onEvent !== stepTriggerEvent(this._stepDef.key));

    if (isExternallyGated) {
      return {
        success: true,
        message: toolResult.message,
        data: toolResult.data as Record<string, any> | undefined,
        cost: toolResult.cost ?? 1,
        new_state: { key: state.key, data: mergedData },
      };
    }

    const transition = this._selectTransition(toolResult);
    const nextStateKey = transition.nextStep === "end" ? "end" : transition.nextStep;

    return {
      success: true,
      message: toolResult.message,
      data: toolResult.data as Record<string, any> | undefined,
      cost: toolResult.cost ?? 1,
      new_state: { key: nextStateKey, data: mergedData },
    };
  }

  private _selectTransition(result: IToolExecutionResult): TransitionDefinition {
    if (this._stepDef.transitions.length === 0) {
      return { onEvent: `step.${this._stepDef.key}.complete`, nextStep: "end" };
    }

    for (const transition of this._stepDef.transitions) {
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

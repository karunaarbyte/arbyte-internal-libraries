import { Workflow } from "fsm-orchestrator";
import type { IState, IEvent } from "fsm-orchestrator";
import type { WorkflowDefinition } from "../types";
import type { IToolRegistry } from "../tools/registry";
import type { LLMActionResolver } from "../llm/LLMActionResolver";
import { LLMStepAction, stepTriggerEvent } from "./LLMStepAction";

// ─────────────────────────────────────────────────────────────
// WorkflowFactory — converts a WorkflowDefinition into an FSM
// Workflow with all triggers and actions wired up.
//
// Trigger wiring strategy:
//   - Initial step: registered on definition.trigger.eventKey
//   - All steps (including initial): also registered on
//     step.{prevStep}.complete events from any step that can
//     transition to them — condition is state.key === step.key
//
// This makes branching work: after a step runs, new_state.key
// is set to the chosen branch's step key. The next event
// (step.{prevStep}.complete) fires, and only the trigger whose
// condition matches state.key will execute.
// ─────────────────────────────────────────────────────────────

export class WorkflowFactory {
  private readonly _registry: IToolRegistry;
  private readonly _resolver: LLMActionResolver;

  constructor(registry: IToolRegistry, resolver: LLMActionResolver) {
    this._registry = registry;
    this._resolver = resolver;
  }

  build(definition: WorkflowDefinition): Workflow {
    this._validateToolKeys(definition);

    const workflow = new Workflow(definition.id, definition.initialStep);

    // Build one Action per step
    const stepActions = new Map(
      definition.steps.map((stepDef) => {
        const llmStepAction = new LLMStepAction(stepDef, this._registry, this._resolver);
        return [stepDef.key, { stepDef, action: llmStepAction.buildAction() }];
      })
    );

    // Wire triggers
    for (const stepDef of definition.steps) {
      const { action } = stepActions.get(stepDef.key)!;
      const stepCondition = (state: IState, _event: IEvent) =>
        state.key === stepDef.key;

      // Initial step: triggered by the external event (e.g. gmail.email_received)
      if (stepDef.key === definition.initialStep) {
        workflow.addTrigger(definition.trigger.eventKey, action, stepCondition);
      }

      // Register this step as a target for every step that can transition to it
      for (const otherStepDef of definition.steps) {
        if (otherStepDef.key === stepDef.key) continue;

        const canTransitionHere = otherStepDef.transitions.some(
          (t) => t.nextStep === stepDef.key
        );

        if (canTransitionHere) {
          workflow.addTrigger(
            stepTriggerEvent(otherStepDef.key),
            action,
            stepCondition
          );
        }
      }
    }

    return workflow;
  }

  private _validateToolKeys(definition: WorkflowDefinition): void {
    for (const step of definition.steps) {
      for (const toolKey of step.allowedTools) {
        if (!this._registry.get(toolKey)) {
          throw new Error(
            `[WorkflowFactory] Step "${step.key}" references unknown tool "${toolKey}". ` +
              `Register the tool before building workflows.`
          );
        }
      }
    }
  }
}

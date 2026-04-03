import { Workflow, Action } from "fsm-orchestrator";
import type { IState, IEvent } from "fsm-orchestrator";
import type { WorkflowDefinition } from "../types";
import type { IToolRegistry } from "../tools/registry";
import type { LLMActionResolver } from "../llm/LLMActionResolver";
import { LLMStepAction, stepTriggerEvent } from "./LLMStepAction";
import type { UsageLogger } from "../persistence/UsageLogger";

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
  private readonly _usageLogger?: UsageLogger;

  constructor(registry: IToolRegistry, resolver: LLMActionResolver, usageLogger?: UsageLogger) {
    this._registry = registry;
    this._resolver = resolver;
    this._usageLogger = usageLogger;
  }

  build(definition: WorkflowDefinition): Workflow {
    this._validateToolKeys(definition);

    const workflow = new Workflow(definition.id, definition.initialStep);

    // Build one LLMStepAction per step (factory, not yet an Action instance)
    const stepActionFactories = new Map(
      definition.steps.map((stepDef) => {
        const llmStepAction = new LLMStepAction(stepDef, definition.id, this._registry, this._resolver, this._usageLogger);
        return [stepDef.key, { stepDef, llmStepAction }];
      })
    );

    // Wire triggers using the actual onEvent values from each transition.
    // Each addTrigger call needs a unique Action instance (addTrigger calls
    // registerAction internally and throws on duplicate keys), so we generate
    // a unique action key per (step, triggering event) pair.
    //
    // This means slack.approval_granted → send_reply is wired correctly,
    // not just step.{predecessor}.complete auto-generated events.

    // Track registered (eventKey, stepKey) pairs to avoid duplicate triggers
    const registered = new Set<string>();

    for (const stepDef of definition.steps) {
      const { llmStepAction } = stepActionFactories.get(stepDef.key)!;

      // conditionStateKey: the state.key value that must be present when this trigger fires.
      // For internal step.X.complete chains, that's the destination step key (stepDef.key).
      // For external-event transitions (e.g. slack.approval_granted), the source step hasn't
      // advanced state yet — the task is still at the SOURCE step's key, so we use that.
      const registerTrigger = (eventKey: string, actionKeySuffix: string, conditionStateKey?: string) => {
        const effectiveStateKey = conditionStateKey ?? stepDef.key;
        const dedupKey = `${eventKey}::${effectiveStateKey}::${stepDef.key}`;
        if (registered.has(dedupKey)) return;
        registered.add(dedupKey);
        workflow.addTrigger(
          eventKey,
          llmStepAction.buildAction(`step.${stepDef.key}.${actionKeySuffix}`, conditionStateKey),
          (state: IState, _event: IEvent) => state.key === effectiveStateKey
        );
      };

      // Initial step: triggered by the external event (e.g. gmail.email_received)
      if (stepDef.key === definition.initialStep) {
        registerTrigger(definition.trigger.eventKey, "init");
      }

      // For every other step whose transition points here, register on that
      // transition's actual onEvent value (not a synthetic step.X.complete key)
      for (const otherStepDef of definition.steps) {
        if (otherStepDef.key === stepDef.key) continue;

        for (const transition of otherStepDef.transitions) {
          if (transition.nextStep !== stepDef.key) continue;
          const isExternalEvent = transition.onEvent !== stepTriggerEvent(otherStepDef.key);
          registerTrigger(
            transition.onEvent,
            `from_${otherStepDef.key}`,
            isExternalEvent ? otherStepDef.key : undefined
          );
        }
      }
    }

    // Register terminal actions for external-event "end" transitions (e.g. slack.approval_rejected → end).
    // These don't map to a real step, so they need a dedicated no-op action that just closes the task.
    for (const stepDef of definition.steps) {
      for (const transition of stepDef.transitions) {
        if (transition.nextStep !== "end") continue;
        const isExternalEvent = transition.onEvent !== stepTriggerEvent(stepDef.key);
        if (!isExternalEvent) continue;

        const dedupKey = `${transition.onEvent}::${stepDef.key}::end`;
        if (registered.has(dedupKey)) continue;
        registered.add(dedupKey);

        const endAction = new Action(
          `step.${stepDef.key}.end_on_${transition.onEvent.replace(/\./g, "_")}`,
          `End workflow on ${transition.onEvent}`,
          (state: IState) => ({ can: state.key === stepDef.key, description: "Terminal" }),
          async (state: IState) => ({
            success: true,
            message: `Workflow ended via ${transition.onEvent}`,
            new_state: { key: "end", data: state.data },
            cost: 0,
          })
        );

        workflow.addTrigger(
          transition.onEvent,
          endAction,
          (state: IState) => state.key === stepDef.key
        );
      }
    }

    return workflow;
  }

  private _validateToolKeys(definition: WorkflowDefinition): void {
    for (const step of definition.steps) {
      if (step.allowedTools.length === 0) {
        throw new Error(
          `[WorkflowFactory] Step "${step.key}" has empty allowedTools — every step must have at least one tool.`
        );
      }
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

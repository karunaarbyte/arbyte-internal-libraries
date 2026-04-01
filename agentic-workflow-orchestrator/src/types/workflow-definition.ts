// ─────────────────────────────────────────────────────────────
// WorkflowDefinition — central schema contract between the
// Skill Compiler and the Workflow Factory.
// Every other module depends on these types — treat as stable.
// ─────────────────────────────────────────────────────────────

export type TToolSource = "gmail" | "slack" | "teams" | "drive" | "notion" | "manual";

export type TTransitionOperator = "eq" | "neq" | "exists" | "not_exists";

// ── Trigger ──────────────────────────────────────────────────

export type TriggerDefinition = {
  source: TToolSource;
  eventKey: string;
  conditions?: Record<string, unknown>;
};

// ── Transitions ──────────────────────────────────────────────

export type TransitionCondition = {
  field: string;
  operator: TTransitionOperator;
  value?: unknown;
};

export type TransitionDefinition = {
  onEvent: string;
  condition?: TransitionCondition;
  nextStep: string; // valid StepDefinition.key or "end"
};

// ── Step ─────────────────────────────────────────────────────

export type StepDefinition = {
  key: string; // maps 1:1 to IState.key in fsm-orchestrator
  description: string;
  allowedTools: string[]; // tool keys from ToolRegistry
  transitions: TransitionDefinition[];
};

// ── Workflow ─────────────────────────────────────────────────

export type WorkflowDefinition = {
  id: string;
  name: string;
  description: string;
  trigger: TriggerDefinition;
  steps: StepDefinition[];
  initialStep: string; // must match a StepDefinition.key
};

// ── Versioning ───────────────────────────────────────────────

export type TVersionStatus = "active" | "backup";

export type WorkflowDefinitionVersion = {
  version: number;
  status: TVersionStatus;
  compiledAt: string; // ISO timestamp
  definition: WorkflowDefinition;
};

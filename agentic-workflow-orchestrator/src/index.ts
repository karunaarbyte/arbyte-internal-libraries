import { ToolRegistry } from "./tools/registry";
import {
  GmailReadAction,
  GmailSendAction,
  GmailReplyAction,
  SlackSendMessageAction,
  SlackReadChannelAction,
  SlackReplyThreadAction,
  DriveReadFileAction,
  DriveWriteFileAction,
  DriveListFilesAction,
} from "./tools";
import { ClaudeClient } from "./llm/providers";
import { LLMActionResolver } from "./llm/LLMActionResolver";
import { LLMSkillParser } from "./skill-compiler/LLMSkillParser";
import { SkillCompiler } from "./skill-compiler/SkillCompiler";
import { DriveWatcher } from "./skill-compiler/DriveWatcher";
import { WorkflowFactory } from "./workflow-factory/WorkflowFactory";
import { AgenticOrchestrator } from "./orchestrator/AgenticOrchestrator";
import {
  WorkflowDefinitionStore,
  TaskStateStore,
  InvocationLogStore,
} from "./persistence";
import { buildWebhookServer, startServer } from "./webhooks";

const PORT = Number(process.env.PORT ?? 3000);
const WORKFLOW_STORAGE_DIR = process.env.WORKFLOW_STORAGE_DIR ?? "./.workflow-store";

// ── Tool registry ─────────────────────────────────────────────

const registry = new ToolRegistry();

registry.register(new GmailReadAction());
registry.register(new GmailSendAction());
registry.register(new GmailReplyAction());
registry.register(new SlackSendMessageAction());
registry.register(new SlackReadChannelAction());
registry.register(new SlackReplyThreadAction());
registry.register(new DriveReadFileAction());
registry.register(new DriveWriteFileAction());
registry.register(new DriveListFilesAction());

// ── LLM clients ───────────────────────────────────────────────
// skill compiler: opus (quality) | step resolver: sonnet (cost)

const compilerLLM = new ClaudeClient({ model: "claude-opus-4-6" });
const resolverLLM = new ClaudeClient({ model: "claude-sonnet-4-6" });

// ── Core services ─────────────────────────────────────────────

const resolver = new LLMActionResolver(resolverLLM);
const factory = new WorkflowFactory(registry, resolver);

const definitionStore = new WorkflowDefinitionStore(WORKFLOW_STORAGE_DIR);
const taskStore = new TaskStateStore();
const logStore = new InvocationLogStore();

const orchestrator = new AgenticOrchestrator(
  definitionStore,
  taskStore,
  logStore,
  factory
);

// ── Skill compiler ────────────────────────────────────────────

const parser = new LLMSkillParser(compilerLLM, registry);
const compiler = new SkillCompiler(
  parser,
  definitionStore,
  (workflowId) => orchestrator.reloadWorkflow(workflowId)
);

const driveWatcher = new DriveWatcher(compiler);

// ── Boot ──────────────────────────────────────────────────────

async function boot(): Promise<void> {
  await orchestrator.loadAllWorkflows();

  const app = buildWebhookServer({ orchestrator, driveWatcher });
  startServer(app, PORT);
}

boot().catch((err) => {
  console.error("[boot] Fatal error:", err);
  process.exit(1);
});

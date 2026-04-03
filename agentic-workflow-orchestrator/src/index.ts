import { ToolRegistry } from "./tools/registry";
import {
  GmailReadAction,
  GmailSendAction,
  GmailReplyAction,
  SlackSendMessageAction,
  SlackReadChannelAction,
  SlackReplyThreadAction,
  SlackSendApprovalRequestAction,
  DriveReadFileAction,
  DriveWriteFileAction,
  DriveListFilesAction,
  DraftTextAction,
} from "./tools";
import { OpenAIClient } from "./llm/providers";
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
import { UsageLogger } from "./persistence/UsageLogger";
import { buildWebhookServer, startServer } from "./webhooks";
import { google } from "googleapis";

const PORT = Number(process.env.PORT ?? 3000);
const WORKFLOW_STORAGE_DIR = process.env.WORKFLOW_STORAGE_DIR ?? "./.workflow-store";
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL ?? "";
const DRIVE_SKILLS_FOLDER_ID = process.env.DRIVE_SKILLS_FOLDER_ID ?? "";
const GMAIL_PUBSUB_TOPIC = process.env.GMAIL_PUBSUB_TOPIC ?? "";

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
registry.register(new DraftTextAction());
registry.register(new SlackSendApprovalRequestAction());

// ── LLM clients ───────────────────────────────────────────────
// skill compiler: gpt-4o (quality) | step resolver: gpt-4o-mini (cost)

const compilerLLM = new OpenAIClient({ model: "gpt-4o" });
const resolverLLM = new OpenAIClient({ model: "gpt-4o-mini" });

// ── Core services ─────────────────────────────────────────────

const usageLogger = new UsageLogger(`${WORKFLOW_STORAGE_DIR}/usage-log.json`);
const resolver = new LLMActionResolver(resolverLLM);
const factory = new WorkflowFactory(registry, resolver, usageLogger);

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

const driveWatcher = new DriveWatcher(compiler, WORKFLOW_STORAGE_DIR);

// ── Boot ──────────────────────────────────────────────────────

async function boot(): Promise<void> {
  await orchestrator.loadAllWorkflows();

  const app = buildWebhookServer({ orchestrator, driveWatcher });
  startServer(app, PORT);

  if (DRIVE_SKILLS_FOLDER_ID && WEBHOOK_BASE_URL) {
    try {
      await driveWatcher.watchFolder(DRIVE_SKILLS_FOLDER_ID, WEBHOOK_BASE_URL);
    } catch (err) {
      console.error("[boot] Drive watcher setup failed:", err);
    }
  } else {
    console.warn("[boot] DRIVE_SKILLS_FOLDER_ID or WEBHOOK_BASE_URL not set — Drive watching disabled");
  }

  if (GMAIL_PUBSUB_TOPIC) {
    try {
      const { getGoogleAuthClient } = await import("./lib/google-auth");
      const gmail = google.gmail({ version: "v1", auth: getGoogleAuthClient() });
      const res = await gmail.users.watch({
        userId: "me",
        requestBody: {
          topicName: GMAIL_PUBSUB_TOPIC,
          labelIds: ["INBOX"],
          labelFilterBehavior: "INCLUDE",
        },
      });
      const expiresAt = res.data.expiration ? new Date(Number(res.data.expiration)).toISOString() : "unknown";
      console.log(`[boot] Gmail watch registered — historyId: ${res.data.historyId}, expires: ${expiresAt}`);
    } catch (err) {
      console.error("[boot] Failed to register Gmail watch:", err);
    }
  } else {
    console.warn("[boot] GMAIL_PUBSUB_TOPIC not set — Gmail webhook disabled");
  }
}

boot().catch((err) => {
  console.error("[boot] Fatal error:", err);
  process.exit(1);
});

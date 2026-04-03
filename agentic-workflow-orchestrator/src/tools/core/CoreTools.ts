import type { IState } from "fsm-orchestrator";
import { ToolAction } from "../base";
import type { ArgDef, IToolExecutionResult } from "../../types";

// ─────────────────────────────────────────────────────────────
// CoreTools — general-purpose tools not tied to any external service.
// ─────────────────────────────────────────────────────────────

// ── DraftTextAction ───────────────────────────────────────────
// Generates a text draft and stores it in state.data under a
// named key. Use this when you need to produce text once and
// reuse it across multiple subsequent steps (e.g. draft a reply,
// then show it in Slack AND send it via Gmail).

export class DraftTextAction extends ToolAction {
  readonly key = "core.draft_text";
  readonly description =
    "Store a generated text draft in state for use by later steps. " +
    "Provide draft_key (the exact state key to store under, e.g. 'reply_body') and text (the content to store). " +
    "Never use this tool to re-read or pass through existing state — only for new LLM-generated content.";

  override readonly inputSchema: ArgDef[] = [
    {
      name: "draft_key",
      description: "The state key to store the draft under (e.g. 'reply_body', 'summary'). Must match the key named in the step description after 'store as'.",
      source: "llm",
      required: true,
    },
    {
      name: "text",
      description: "The generated text content to store. Must be the full, final draft — no truncation.",
      source: "llm",
      required: true,
    },
  ];

  // Sentinel — the actual key written is determined at runtime from draft_key arg.
  override readonly outputFields = ["<draft_key>"];

  async execute(
    args: Record<string, unknown>,
    _state: IState
  ): Promise<IToolExecutionResult> {
    const draftKey = args.draft_key as string;
    const text = args.text as string;

    if (!draftKey || !text) {
      return { success: false, message: "Missing required args: draft_key, text", failureKind: "arg_error" };
    }

    return {
      success: true,
      message: `Draft stored under "${draftKey}"`,
      data: { [draftKey]: text },
      cost: 0,
    };
  }
}

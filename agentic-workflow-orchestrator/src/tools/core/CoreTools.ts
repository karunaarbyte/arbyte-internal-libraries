import type { IState } from "fsm-orchestrator";
import { ToolAction } from "../base";
import type { IToolExecutionResult } from "../../types";

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
    "Draft a piece of text (reply, message, summary) and store it in state for use by later steps. " +
    "Requires: draft_key (the state key to store under, e.g. 'reply_body'), text (the content to store).";

  async execute(
    args: Record<string, unknown>,
    _state: IState
  ): Promise<IToolExecutionResult> {
    const draftKey = args.draft_key as string;
    const text = args.text as string;

    if (!draftKey || !text) {
      return { success: false, message: "Missing required args: draft_key, text", cost: 0 };
    }

    return {
      success: true,
      message: `Draft stored under "${draftKey}"`,
      data: { [draftKey]: text },
      cost: 0,
    };
  }
}

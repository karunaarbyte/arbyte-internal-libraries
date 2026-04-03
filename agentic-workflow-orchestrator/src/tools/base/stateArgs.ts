import type { IState } from "fsm-orchestrator";

// ─────────────────────────────────────────────────────────────
// stateArgs — helpers for reading tool inputs.
//
// The LLM resolver sees a truncated view of state for cost reasons.
// When it passes text content back as args, it may reproduce the
// truncated version. Tools must prefer state.data (full, untruncated)
// over LLM-provided args for any content stored by a previous step.
// ─────────────────────────────────────────────────────────────

/**
 * Read a value from state.data under any of the given keys (first match wins),
 * falling back to the LLM-provided arg value. Use for content fields that may
 * have been stored by a previous step (e.g. reply_body, draft_body).
 */
export function fromState(
  state: IState,
  stateKeys: string[],
  argFallback?: unknown
): string | undefined {
  for (const key of stateKeys) {
    const v = state.data[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return typeof argFallback === "string" && argFallback.length > 0
    ? argFallback
    : undefined;
}

/**
 * Read a scalar (string/number/boolean) from args first, then state.
 * Use for inputs the LLM is expected to generate (not pass-through from state).
 */
export function fromArgs(
  args: Record<string, unknown>,
  argKey: string,
  state: IState,
  stateKey?: string
): unknown {
  return args[argKey] ?? (stateKey ? state.data[stateKey] : undefined);
}

// Matches common closing lines the LLM adds despite instructions not to.
// Anchored to end-of-string after optional whitespace.
const SIGNATURE_PATTERN =
  /(\n+\s*(best|regards|sincerely|thanks|cheers|warm regards|kind regards|thank you)[,.]?\s*\n[\s\S]*|\n+\s*\[your name\]\s*$)/i;

/**
 * Strip any trailing sign-off / signature block the LLM may have included.
 * Call this before appending a system-managed signature.
 */
export function stripTrailingSignature(text: string): string {
  return text.replace(SIGNATURE_PATTERN, "").trimEnd();
}

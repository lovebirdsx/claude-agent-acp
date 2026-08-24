/**
 * Mid-turn session-cost ledger.
 *
 * Why the fork needs this: the SDK only reports per-model cost on the terminal
 * `result` message (`SDKResultMessage.modelUsage`), so the client's cost readout
 * used to freeze for the entire duration of a turn — minutes, on Task-heavy
 * work. The adapter already emits a `usage_update` mid-turn (from
 * `stream_event`), and the editor prices token counts locally, so all that is
 * missing on the wire is a per-model token breakdown.
 *
 * This file keeps that breakdown honest with a two-part ledger:
 *
 *   base    = the last authoritative `result.modelUsage` snapshot
 *             (session-cumulative, already folds in sub-agent/Task work)
 *   overlay = this turn's per-model tokens that no `result` has confirmed yet
 *
 * Mid-turn rows are `base ⊕ overlay`, which is monotonic; when a `result`
 * arrives the authoritative snapshot replaces `base` and the overlay is
 * dropped, so nothing is counted twice and nothing is lost.
 *
 * Lives in its own file (rather than in the 10k-line `acp-agent.ts`) to keep the
 * fork's diff against upstream confined to five small wiring points.
 */

import type { SubagentStatsState } from "./tools.js";

/**
 * One row of `_meta._universe/modelBreakdown`.
 *
 * `costUSD` is absent — not zero — when the client has to price the row itself:
 * mid-turn rows the overlay touched carry fresh token counts that the last
 * authoritative unit price no longer describes. Rows copied verbatim from
 * `base` keep their figure so a session with no local rate table (an official
 * subscription) does not lose the numbers it already had.
 */
export type SessionCostRow = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUSD?: number;
};

/** Raw Anthropic usage block as carried on an assistant message / message_delta. */
type UsageBlock = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

type TokenTally = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
};

export interface MidturnCostLedger {
  /** Authoritative session-cumulative rows, keyed by model id. */
  base: Map<string, SessionCostRow>;
  /**
   * Unconfirmed per-model tokens for the running turn. Keyed by API message id
   * so a re-reported snapshot of the same message replaces its predecessor;
   * frames without an id fall back to a per-model accumulation key.
   */
  overlay: Map<string, { model: string; tokens: TokenTally }>;
  /**
   * Overlay key standing in for the message currently streaming without an API
   * id, so its deltas replace one another instead of stacking.
   */
  unkeyed?: string;
  /** Monotonic counter minting `unkeyed` keys. */
  unkeyedSeq: number;
  /**
   * Sub-agent totals already folded into `base`, keyed by parent tool_use id.
   * `session.subagentStats` is session-cumulative and never pruned, so only the
   * delta against this baseline belongs in the overlay.
   */
  subagentBaseline: Map<string, TokenTally>;
}

export function createMidturnCostLedger(): MidturnCostLedger {
  return { base: new Map(), overlay: new Map(), subagentBaseline: new Map(), unkeyedSeq: 0 };
}

/**
 * Replace `base` with the authoritative breakdown a `result` just reported, and
 * re-baseline the sub-agent tallies it already folds in.
 *
 * `clearOverlay` is false for an autonomous result (a background task finishing
 * while the user's turn runs): its snapshot advances `base`, but the user turn's
 * in-flight overlay must survive or the displayed cost would jump backwards.
 *
 * An empty `rows` is a no-op: a result that reports no `modelUsage` confirms
 * nothing, so wiping `base` there would throw away the only authoritative
 * figures the session has.
 */
export function adoptAuthoritativeBreakdown(
  ledger: MidturnCostLedger,
  rows: readonly SessionCostRow[],
  state: SubagentStatsState,
  clearOverlay: boolean,
): void {
  if (rows.length === 0) return;
  ledger.base = new Map(rows.map((row) => [row.model, { ...row }]));
  ledger.subagentBaseline = new Map();
  for (const [parentToolUseId, entry] of state) {
    ledger.subagentBaseline.set(parentToolUseId, {
      input: entry.inputTokens,
      output: entry.outputTokens,
      cacheRead: entry.cacheReadTokens,
      cacheCreate: entry.cacheCreateTokens,
    });
  }
  if (clearOverlay) {
    ledger.overlay.clear();
    ledger.unkeyed = undefined;
  }
}

/**
 * Drop the overlay without touching `base`. Called when a turn becomes active:
 * the overlay means "this turn's unconfirmed tokens", and a turn that was
 * cancelled never produced the `result` that would have cleared it, so its
 * tokens would otherwise linger — and accumulate across repeated cancels.
 */
export function clearOverlay(ledger: MidturnCostLedger): void {
  ledger.overlay.clear();
  ledger.unkeyed = undefined;
}

/**
 * Fold a top-level assistant snapshot into the overlay.
 *
 * Per the Anthropic API, `message_delta.usage` fields are CUMULATIVE for the
 * message rather than incremental, so a snapshot carrying an id REPLACES that
 * id's earlier contribution (the same dedupe `accumulateSubagentUsage` does for
 * sub-agents). Frames without an id get a synthetic key per streaming message
 * (`isMessageStart` opens a new one), which keeps replace semantics — plain
 * accumulation would multiply a message whose deltas each repeat its running
 * total.
 */
export function recordTopLevelSnapshot(
  ledger: MidturnCostLedger,
  messageId: string | undefined,
  model: string | undefined,
  usage: UsageBlock | null | undefined,
  isMessageStart = false,
): void {
  if (model === undefined || model.length === 0 || model === "<synthetic>") return;
  if (messageId !== undefined && messageId.length > 0) {
    const tokens = toTally(usage);
    if (total(tokens) === 0) return;
    ledger.overlay.set(messageId, { model, tokens });
    return;
  }
  // Mint the synthetic key BEFORE the all-zero bail-out: gateways that lead a
  // message with an empty usage block (Moonshot/kimi) would otherwise never
  // advance the key, so every id-less message of the turn would overwrite the
  // first one instead of adding to it.
  if (isMessageStart || ledger.unkeyed === undefined) {
    ledger.unkeyedSeq += 1;
    ledger.unkeyed = `unkeyed:${ledger.unkeyedSeq}`;
  }
  const tokens = toTally(usage);
  if (total(tokens) === 0) return;
  ledger.overlay.set(ledger.unkeyed, { model, tokens });
}

/**
 * Build the wire rows for a mid-turn `usage_update`: the authoritative base plus
 * this turn's unconfirmed top-level and sub-agent tokens. Returns [] when there
 * is nothing to report, so the caller can omit `_meta` entirely.
 */
export function buildMidturnRows(
  ledger: MidturnCostLedger,
  state: SubagentStatsState,
): SessionCostRow[] {
  const rows: SessionCostRow[] = [...ledger.base.values()].map((row) => ({ ...row }));
  for (const { model, tokens } of ledger.overlay.values()) {
    foldTokens(rows, model, tokens);
  }
  for (const [parentToolUseId, entry] of state) {
    if (entry.model === undefined || entry.model.length === 0) continue;
    const baseline = ledger.subagentBaseline.get(parentToolUseId);
    const delta: TokenTally = {
      input: positive(entry.inputTokens - (baseline?.input ?? 0)),
      output: positive(entry.outputTokens - (baseline?.output ?? 0)),
      cacheRead: positive(entry.cacheReadTokens - (baseline?.cacheRead ?? 0)),
      cacheCreate: positive(entry.cacheCreateTokens - (baseline?.cacheCreate ?? 0)),
    };
    if (total(delta) === 0) continue;
    foldTokens(rows, entry.model, delta);
  }
  return rows;
}

/**
 * Merge tokens into the row for `model`, dropping that row's `costUSD` because
 * the authoritative figure no longer matches the token counts. Appends a new row
 * when no existing row describes the model.
 */
function foldTokens(rows: SessionCostRow[], model: string, tokens: TokenTally): void {
  const index = findRowIndex(rows, model);
  if (index === -1) {
    rows.push({
      model,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheReadTokens: tokens.cacheRead,
      cacheCreateTokens: tokens.cacheCreate,
    });
    return;
  }
  const row = rows[index] as SessionCostRow;
  rows[index] = {
    model: row.model,
    inputTokens: row.inputTokens + tokens.input,
    outputTokens: row.outputTokens + tokens.output,
    cacheReadTokens: row.cacheReadTokens + tokens.cacheRead,
    cacheCreateTokens: row.cacheCreateTokens + tokens.cacheCreate,
  };
}

/**
 * Locate the row describing `model`. An exact match always wins; otherwise a
 * lane-decorated spelling matches its bare form in either direction, because
 * `modelUsage` keys and assistant `message.model` disagree on the `[1m]` suffix.
 * No family guessing beyond that.
 */
function findRowIndex(rows: readonly SessionCostRow[], model: string): number {
  let lane = -1;
  for (const [index, row] of rows.entries()) {
    if (row.model === model) return index;
    if (lane === -1 && (row.model.startsWith(`${model}[`) || model.startsWith(`${row.model}[`))) {
      lane = index;
    }
  }
  return lane;
}

function toTally(usage: UsageBlock | null | undefined): TokenTally {
  return {
    input: num(usage?.input_tokens),
    output: num(usage?.output_tokens),
    cacheRead: num(usage?.cache_read_input_tokens),
    cacheCreate: num(usage?.cache_creation_input_tokens),
  };
}

function total(tokens: TokenTally): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate;
}

function positive(value: number): number {
  return value > 0 ? value : 0;
}

function num(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

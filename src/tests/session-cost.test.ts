import { describe, it, expect } from "vitest";
import {
  adoptAuthoritativeBreakdown,
  buildMidturnRows,
  clearOverlay,
  createMidturnCostLedger,
  recordTopLevelSnapshot,
  type SessionCostRow,
} from "../session-cost.js";
import type { SubagentStatsEntry, SubagentStatsState } from "../tools.js";

function row(partial: Partial<SessionCostRow> & { model: string }): SessionCostRow {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    ...partial,
  };
}

function usage(partial: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreate?: number;
}) {
  return {
    input_tokens: partial.input ?? 0,
    output_tokens: partial.output ?? 0,
    cache_read_input_tokens: partial.cacheRead ?? 0,
    cache_creation_input_tokens: partial.cacheCreate ?? 0,
  };
}

function subagents(
  entries: Array<[string, Partial<SubagentStatsEntry> & { model?: string }]>,
): SubagentStatsState {
  return new Map(
    entries.map(([id, partial]) => [
      id,
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        ...partial,
      },
    ]),
  );
}

const NO_SUBAGENTS: SubagentStatsState = new Map();

describe("adoptAuthoritativeBreakdown", () => {
  it("replaces the base and drops the confirmed overlay", () => {
    const ledger = createMidturnCostLedger();
    recordTopLevelSnapshot(ledger, "msg_1", "claude-opus-5", usage({ output: 300 }));

    adoptAuthoritativeBreakdown(
      ledger,
      [row({ model: "claude-opus-5", inputTokens: 1000, outputTokens: 300, costUSD: 0.5 })],
      NO_SUBAGENTS,
      true,
    );

    expect(ledger.overlay.size).toBe(0);
    expect(buildMidturnRows(ledger, NO_SUBAGENTS)).toEqual([
      row({ model: "claude-opus-5", inputTokens: 1000, outputTokens: 300, costUSD: 0.5 }),
    ]);
  });

  it("keeps the in-flight overlay for an autonomous result", () => {
    const ledger = createMidturnCostLedger();
    recordTopLevelSnapshot(ledger, "msg_1", "claude-opus-5", usage({ output: 300 }));

    adoptAuthoritativeBreakdown(
      ledger,
      [row({ model: "claude-opus-5", inputTokens: 1000, costUSD: 0.5 })],
      NO_SUBAGENTS,
      false,
    );

    // The user's turn is still running: its 300 output tokens must survive, or
    // the client's cost readout would jump backwards.
    expect(buildMidturnRows(ledger, NO_SUBAGENTS)).toEqual([
      row({ model: "claude-opus-5", inputTokens: 1000, outputTokens: 300 }),
    ]);
  });

  it("ignores a result that reports no modelUsage", () => {
    const ledger = createMidturnCostLedger();
    adoptAuthoritativeBreakdown(
      ledger,
      [row({ model: "claude-opus-5", inputTokens: 1000, costUSD: 0.5 })],
      NO_SUBAGENTS,
      true,
    );

    adoptAuthoritativeBreakdown(ledger, [], NO_SUBAGENTS, true);

    expect(buildMidturnRows(ledger, NO_SUBAGENTS)).toEqual([
      row({ model: "claude-opus-5", inputTokens: 1000, costUSD: 0.5 }),
    ]);
  });
});

describe("recordTopLevelSnapshot", () => {
  it("replaces rather than accumulates snapshots of the same message", () => {
    const ledger = createMidturnCostLedger();
    // message_delta usage is cumulative for the message, not incremental.
    recordTopLevelSnapshot(ledger, "msg_1", "claude-opus-5", usage({ output: 300 }));
    recordTopLevelSnapshot(ledger, "msg_1", "claude-opus-5", usage({ output: 500 }));

    expect(buildMidturnRows(ledger, NO_SUBAGENTS)).toEqual([
      row({ model: "claude-opus-5", outputTokens: 500 }),
    ]);
  });

  it("accumulates distinct messages", () => {
    const ledger = createMidturnCostLedger();
    recordTopLevelSnapshot(ledger, "msg_1", "claude-opus-5", usage({ output: 300 }));
    recordTopLevelSnapshot(ledger, "msg_2", "claude-opus-5", usage({ output: 200 }));

    expect(buildMidturnRows(ledger, NO_SUBAGENTS)).toEqual([
      row({ model: "claude-opus-5", outputTokens: 500 }),
    ]);
  });

  it("replaces the deltas of one id-less streaming message", () => {
    const ledger = createMidturnCostLedger();
    // message_delta usage repeats the message's running total, so a plain
    // accumulation would multiply it.
    recordTopLevelSnapshot(ledger, undefined, "claude-opus-5", usage({ output: 300 }), true);
    recordTopLevelSnapshot(ledger, undefined, "claude-opus-5", usage({ output: 500 }));

    expect(buildMidturnRows(ledger, NO_SUBAGENTS)).toEqual([
      row({ model: "claude-opus-5", outputTokens: 500 }),
    ]);
  });

  it("accumulates across id-less messages, keyed by message_start", () => {
    const ledger = createMidturnCostLedger();
    recordTopLevelSnapshot(ledger, undefined, "claude-opus-5", usage({ output: 300 }), true);
    recordTopLevelSnapshot(ledger, undefined, "claude-opus-5", usage({ output: 200 }), true);

    expect(buildMidturnRows(ledger, NO_SUBAGENTS)).toEqual([
      row({ model: "claude-opus-5", outputTokens: 500 }),
    ]);
  });

  it("ignores all-zero snapshots and synthetic / missing models", () => {
    const ledger = createMidturnCostLedger();
    recordTopLevelSnapshot(ledger, "msg_1", "claude-opus-5", usage({}));
    recordTopLevelSnapshot(ledger, "msg_2", "<synthetic>", usage({ output: 300 }));
    recordTopLevelSnapshot(ledger, "msg_3", undefined, usage({ output: 300 }));
    recordTopLevelSnapshot(ledger, "msg_4", "claude-opus-5", null);

    expect(buildMidturnRows(ledger, NO_SUBAGENTS)).toEqual([]);
  });

  // Moonshot/kimi lead a message with an all-zero usage block. If the bail-out
  // on zero ran before the synthetic key was minted, the key would never
  // advance and every later id-less message would overwrite the first.
  it("still opens a new id-less key when message_start reports zero usage", () => {
    const ledger = createMidturnCostLedger();
    recordTopLevelSnapshot(ledger, undefined, "kimi-k2.6", usage({}), true);
    recordTopLevelSnapshot(ledger, undefined, "kimi-k2.6", usage({ output: 300 }));
    recordTopLevelSnapshot(ledger, undefined, "kimi-k2.6", usage({}), true);
    recordTopLevelSnapshot(ledger, undefined, "kimi-k2.6", usage({ output: 200 }));

    expect(buildMidturnRows(ledger, NO_SUBAGENTS)).toEqual([
      row({ model: "kimi-k2.6", outputTokens: 500 }),
    ]);
  });
});

describe("clearOverlay", () => {
  // A cancelled turn never produces the `result` that would clear its overlay.
  it("drops unconfirmed tokens while leaving the base authoritative", () => {
    const ledger = createMidturnCostLedger();
    adoptAuthoritativeBreakdown(
      ledger,
      [row({ model: "claude-opus-5", inputTokens: 1000, costUSD: 0.5 })],
      NO_SUBAGENTS,
      true,
    );
    recordTopLevelSnapshot(ledger, "msg_1", "claude-opus-5", usage({ output: 300 }));

    clearOverlay(ledger);

    expect(buildMidturnRows(ledger, NO_SUBAGENTS)).toEqual([
      row({ model: "claude-opus-5", inputTokens: 1000, costUSD: 0.5 }),
    ]);
  });

  it("does not fuse the next id-less message onto the cleared one", () => {
    const ledger = createMidturnCostLedger();
    recordTopLevelSnapshot(ledger, undefined, "claude-opus-5", usage({ output: 300 }), true);

    clearOverlay(ledger);
    recordTopLevelSnapshot(ledger, undefined, "claude-opus-5", usage({ output: 200 }));

    expect(buildMidturnRows(ledger, NO_SUBAGENTS)).toEqual([
      row({ model: "claude-opus-5", outputTokens: 200 }),
    ]);
  });
});

describe("buildMidturnRows", () => {
  it("returns nothing for an untouched ledger", () => {
    expect(buildMidturnRows(createMidturnCostLedger(), NO_SUBAGENTS)).toEqual([]);
  });

  it("strips costUSD from touched rows and keeps it on untouched ones", () => {
    const ledger = createMidturnCostLedger();
    adoptAuthoritativeBreakdown(
      ledger,
      [
        row({ model: "claude-opus-5", inputTokens: 1000, costUSD: 0.5 }),
        row({ model: "claude-haiku-4-5", inputTokens: 200, costUSD: 0.01 }),
      ],
      NO_SUBAGENTS,
      true,
    );
    recordTopLevelSnapshot(ledger, "msg_1", "claude-opus-5", usage({ input: 200 }));

    const rows = buildMidturnRows(ledger, NO_SUBAGENTS);
    // Touched: tokens moved, so the old unit price is a lie — the client re-prices.
    expect(rows[0]).toEqual(row({ model: "claude-opus-5", inputTokens: 1200 }));
    // Untouched: keeping the figure is what stops a subscription session (no
    // local rate table) from losing the numbers it already had.
    expect(rows[1]).toEqual(row({ model: "claude-haiku-4-5", inputTokens: 200, costUSD: 0.01 }));
  });

  it("merges a lane-decorated overlay into its bare base row", () => {
    const ledger = createMidturnCostLedger();
    adoptAuthoritativeBreakdown(
      ledger,
      [row({ model: "deepseek-v4-pro", inputTokens: 1000, costUSD: 0.5 })],
      NO_SUBAGENTS,
      true,
    );
    recordTopLevelSnapshot(ledger, "msg_1", "deepseek-v4-pro[1m]", usage({ input: 200 }));

    expect(buildMidturnRows(ledger, NO_SUBAGENTS)).toEqual([
      row({ model: "deepseek-v4-pro", inputTokens: 1200 }),
    ]);
  });

  it("merges a bare overlay into its lane-decorated base row", () => {
    const ledger = createMidturnCostLedger();
    adoptAuthoritativeBreakdown(
      ledger,
      [row({ model: "deepseek-v4-pro[1m]", inputTokens: 1000, costUSD: 0.5 })],
      NO_SUBAGENTS,
      true,
    );
    recordTopLevelSnapshot(ledger, "msg_1", "deepseek-v4-pro", usage({ input: 200 }));

    expect(buildMidturnRows(ledger, NO_SUBAGENTS)).toEqual([
      row({ model: "deepseek-v4-pro[1m]", inputTokens: 1200 }),
    ]);
  });

  it("prefers an exact row over a lane-decorated sibling", () => {
    const ledger = createMidturnCostLedger();
    adoptAuthoritativeBreakdown(
      ledger,
      [
        row({ model: "claude-sonnet-5[1m]", inputTokens: 1000, costUSD: 0.5 }),
        row({ model: "claude-sonnet-5", inputTokens: 100, costUSD: 0.02 }),
      ],
      NO_SUBAGENTS,
      true,
    );
    recordTopLevelSnapshot(ledger, "msg_1", "claude-sonnet-5", usage({ input: 200 }));

    const rows = buildMidturnRows(ledger, NO_SUBAGENTS);
    expect(rows[0]).toEqual(row({ model: "claude-sonnet-5[1m]", inputTokens: 1000, costUSD: 0.5 }));
    expect(rows[1]).toEqual(row({ model: "claude-sonnet-5", inputTokens: 300 }));
  });

  it("appends a row for a model the base never saw", () => {
    const ledger = createMidturnCostLedger();
    adoptAuthoritativeBreakdown(
      ledger,
      [row({ model: "claude-opus-5", inputTokens: 1000, costUSD: 0.5 })],
      NO_SUBAGENTS,
      true,
    );
    recordTopLevelSnapshot(ledger, "msg_1", "claude-haiku-4-5", usage({ output: 50 }));

    expect(buildMidturnRows(ledger, NO_SUBAGENTS)).toEqual([
      row({ model: "claude-opus-5", inputTokens: 1000, costUSD: 0.5 }),
      row({ model: "claude-haiku-4-5", outputTokens: 50 }),
    ]);
  });
});

describe("buildMidturnRows — sub-agent deltas", () => {
  it("counts only the tokens accrued since the last authoritative snapshot", () => {
    const ledger = createMidturnCostLedger();
    const state = subagents([["tool_1", { model: "claude-opus-5", outputTokens: 400 }]]);
    // `session.subagentStats` is session-cumulative and never pruned, so the
    // 400 already folded into modelUsage must not be counted a second time.
    adoptAuthoritativeBreakdown(
      ledger,
      [row({ model: "claude-opus-5", outputTokens: 400, costUSD: 0.5 })],
      state,
      true,
    );

    expect(buildMidturnRows(ledger, state)).toEqual([
      row({ model: "claude-opus-5", outputTokens: 400, costUSD: 0.5 }),
    ]);

    state.set("tool_1", { model: "claude-opus-5", ...zeroExcept({ outputTokens: 700 }) });
    expect(buildMidturnRows(ledger, state)).toEqual([
      row({ model: "claude-opus-5", outputTokens: 700 }),
    ]);
  });

  it("counts a sub-agent started after the snapshot in full", () => {
    const ledger = createMidturnCostLedger();
    adoptAuthoritativeBreakdown(
      ledger,
      [row({ model: "claude-opus-5", outputTokens: 400, costUSD: 0.5 })],
      NO_SUBAGENTS,
      true,
    );

    const state = subagents([["tool_1", { model: "claude-haiku-4-5", outputTokens: 250 }]]);
    expect(buildMidturnRows(ledger, state)).toEqual([
      row({ model: "claude-opus-5", outputTokens: 400, costUSD: 0.5 }),
      row({ model: "claude-haiku-4-5", outputTokens: 250 }),
    ]);
  });

  it("skips entries with no model and zero deltas", () => {
    const ledger = createMidturnCostLedger();
    const state = subagents([
      ["tool_1", { outputTokens: 250 }],
      ["tool_2", { model: "claude-opus-5" }],
    ]);

    expect(buildMidturnRows(ledger, state)).toEqual([]);
  });
});

function zeroExcept(partial: Partial<SubagentStatsEntry>): SubagentStatsEntry {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    ...partial,
  };
}

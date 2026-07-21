/**
 * Regression: a mid-turn ("steering") prompt the CLI folds into the running
 * generation must not leave its `session/prompt` hanging forever.
 *
 * The fork's turn accounting relies on the CLI echoing every queued user message
 * back (activating its turn) and emitting a per-turn result. When a steering
 * prompt is merged into the prior turn's generation, the CLI may never echo it
 * or emit a distinct result — so without a backstop the queued turn's deferred
 * never settles (session stuck "running", message "swallowed").
 *
 * The backstop: after the SDK goes idle (its authoritative turn-over signal), if
 * a queued turn was never echoed and nothing else follows within a short grace
 * window, presume it was folded and settle it `end_turn`. A real (lagged) echo
 * cancels the watchdog and activates the turn normally.
 */
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ClaudeAcpAgent } from "../acp-agent.js";
import type { AcpClient } from "../acp-agent.js";
import { Pushable } from "../utils.js";

function createMockAgent() {
  const mockClient = { sessionUpdate: async () => {} } as unknown as AcpClient;
  const agent = new ClaudeAcpAgent(mockClient, { log: () => {}, error: () => {} });
  // Shrink the watchdog so the tests don't wait the full production window.
  agent.orphanQueuedTurnGraceMs = 40;
  return agent;
}

function userEcho(u: any) {
  return {
    type: "user",
    message: u.message,
    parent_tool_use_id: null,
    uuid: u.uuid,
    session_id: "test-session",
    isReplay: true,
  };
}

function result(stop_reason: string | null = "end_turn") {
  return {
    type: "result" as const,
    subtype: "success" as const,
    stop_reason,
    is_error: false,
    result: "",
    errors: [],
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: "test-session",
  };
}

function idle() {
  return { type: "system", subtype: "session_state_changed", state: "idle" };
}

function installSession(
  agent: ClaudeAcpAgent,
  makeGen: (input: Pushable<any>) => AsyncGenerator<any>,
) {
  const input = new Pushable<any>();
  const gen = Object.assign(makeGen(input), {
    interrupt: vi.fn(async () => {}),
    close: vi.fn(),
    setModel: vi.fn(async () => {}),
  });
  agent.sessions["test-session"] = {
    query: gen as any,
    input,
    cancelled: false,
    cwd: "/test",
    sessionFingerprint: JSON.stringify({ cwd: "/test", mcpServers: [] }),
    modes: { currentModeId: "default", availableModes: [] },
    models: { currentModelId: "default", availableModels: [] },
    modelInfos: [],
    settingsManager: { dispose: vi.fn(), getSettings: () => ({}) } as any,
    accumulatedUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    },
    configOptions: [],
    agents: [],
    currentAgent: "default",
    fastModeEnabled: false,
    abortController: new AbortController(),
    emitRawSDKMessages: false,
    contextWindowSize: 200000,
    taskState: new Map(),
    subagentStats: new Map(),
    toolUseCache: {},
    emittedToolCalls: new Set(),
    messageIdToUuid: new Map(),
  } as any;
  return input;
}

/** Race a prompt against a timeout; returns the resolved value or a timeout marker. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | { __timedOut: true }> {
  return Promise.race([
    p,
    new Promise<{ __timedOut: true }>((r) => setTimeout(() => r({ __timedOut: true }), ms)),
  ]);
}

describe("mid-turn steering: orphan queued-turn backstop", () => {
  it("settles a queued turn the CLI folded into the prior generation (echo1, result1, idle, no echo2)", async () => {
    const agent = createMockAgent();
    let holdOpen: (() => void) | undefined;
    installSession(agent, (input) => {
      async function* gen() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value);
        await iter.next(); // msg2 consumed (folded), never echoed
        yield result("end_turn"); // settles turn1
        yield idle(); // authoritative turn-over — arms the watchdog for turn2
        await new Promise<void>((r) => (holdOpen = r)); // keep stream open
      }
      return gen();
    });

    const p1 = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "first" }],
    });
    const p2 = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "steer" }],
    });
    await p1;

    const r2 = await withTimeout(p2, 500);
    expect(r2).not.toHaveProperty("__timedOut");
    expect((r2 as any).stopReason).toBe("end_turn");
    // Queue drained; the late (uuid-less) fold result, if any, is pre-counted.
    expect(agent.sessions["test-session"]?.turnQueue ?? []).toHaveLength(0);

    holdOpen?.();
  });

  it("does NOT fire when a lagged echo activates the queued turn within the grace window", async () => {
    // The #825 race: idle precedes the SDK reading freshly-pushed input. The
    // echo arrives shortly after idle and must activate the turn normally — the
    // watchdog must be cancelled, not settle a live turn early.
    const agent = createMockAgent();
    installSession(agent, (input) => {
      async function* gen() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value);
        yield result("end_turn");
        yield idle(); // arms watchdog
        const u2 = await iter.next();
        // Lagged echo lands within the grace window → cancels watchdog, activates.
        yield userEcho(u2.value);
        yield result("end_turn"); // turn2's real result
        yield idle();
      }
      return gen();
    });

    const p1 = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "first" }],
    });
    const p2 = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });
    const r1 = await p1;
    const r2 = await p2;
    expect(r1.stopReason).toBe("end_turn");
    expect(r2.stopReason).toBe("end_turn");
    // turn2 settled on its OWN result (real usage), not the early watchdog.
    expect(r2.usage?.inputTokens).toBe(10);
  });

  it("does NOT arm while a turn is still actively running (no idle yet)", async () => {
    // Two concurrent prompts; turn1 is running (echoed, no result yet) and turn2
    // is queued. No idle has fired, so the watchdog must not settle turn2.
    const agent = createMockAgent();
    let releaseTurn1: (() => void) | undefined;
    let holdOpen: (() => void) | undefined;
    installSession(agent, (input) => {
      async function* gen() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value); // turn1 active, running
        await iter.next(); // turn2 pushed & queued
        await new Promise<void>((r) => (releaseTurn1 = r)); // turn1 keeps running
        yield result("end_turn");
        yield idle();
        await new Promise<void>((r) => (holdOpen = r)); // keep stream open
      }
      return gen();
    });
    const p1 = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "first" }],
    });
    const p2 = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });

    // Wait past the grace window while turn1 is still running.
    const early = await withTimeout(p2, 120);
    expect(early).toHaveProperty("__timedOut"); // turn2 correctly still pending

    releaseTurn1?.();
    // turn1's result settles turn1, but turn2 was never echoed → after idle the
    // watchdog now settles it end_turn.
    await p1;
    const r2 = await withTimeout(p2, 500);
    expect(r2).not.toHaveProperty("__timedOut");
    expect((r2 as any).stopReason).toBe("end_turn");
    holdOpen?.();
  });

  it("settles ALL never-echoed queued turns when several steering prompts were folded", async () => {
    const agent = createMockAgent();
    let holdOpen: (() => void) | undefined;
    installSession(agent, (input) => {
      async function* gen() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value);
        await iter.next(); // msg2 folded, no echo
        await iter.next(); // msg3 folded, no echo
        yield result("end_turn"); // settles turn1
        yield idle(); // arms watchdog for turn2 + turn3
        await new Promise<void>((r) => (holdOpen = r));
      }
      return gen();
    });
    const p1 = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "first" }],
    });
    const p2 = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "steer a" }],
    });
    const p3 = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "steer b" }],
    });
    await p1;
    const [r2, r3] = await Promise.all([withTimeout(p2, 500), withTimeout(p3, 500)]);
    expect(r2).not.toHaveProperty("__timedOut");
    expect(r3).not.toHaveProperty("__timedOut");
    expect((r2 as any).stopReason).toBe("end_turn");
    expect((r3 as any).stopReason).toBe("end_turn");
    expect(agent.sessions["test-session"]?.turnQueue ?? []).toHaveLength(0);
    holdOpen?.();
  });

  it("baseline unaffected: two distinct queued turns each echo+result and settle", async () => {
    const agent = createMockAgent();
    installSession(agent, (input) => {
      async function* gen() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value);
        yield result("end_turn");
        yield idle();
        const u2 = await iter.next();
        yield userEcho(u2.value);
        yield result("end_turn");
        yield idle();
      }
      return gen();
    });
    const p1 = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "first" }],
    });
    const p2 = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });
    expect((await p1).stopReason).toBe("end_turn");
    expect((await p2).stopReason).toBe("end_turn");
  });
});

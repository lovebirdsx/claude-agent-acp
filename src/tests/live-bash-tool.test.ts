import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  runLiveCommand,
  resolveShell,
  createLiveBashTool,
  createLiveBashCorrelationStore,
  createLiveBashPreToolUseHook,
  LIVE_BASH_QUALIFIED_NAME,
  type LiveBashContext,
  type LiveBashClient,
  type SpawnShellFn,
} from "../liveBashTool.js";
import type { Logger } from "../acp-agent.js";

const logger: Logger = { log: () => {}, error: () => {} };

/** A fake child process we can drive from tests: emit stdout/stderr chunks, then
 *  close with a code/signal. `kill` records that it was called. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  killed = false;
  kill(_signal?: string | number): boolean {
    this.killed = true;
    return true;
  }
}

function makeClient(): {
  client: LiveBashClient;
  updates: Array<Record<string, unknown>>;
} {
  const updates: Array<Record<string, unknown>> = [];
  const client: LiveBashClient = {
    sessionUpdate: async ({ update }) => {
      updates.push(update);
    },
  };
  return { client, updates };
}

function deltaTexts(updates: Array<Record<string, unknown>>): string[] {
  return updates
    .map(
      (u) =>
        (u._meta as { terminal_output_delta?: { data?: string } })?.terminal_output_delta?.data,
    )
    .filter((d): d is string => typeof d === "string");
}

function exitUpdate(updates: Array<Record<string, unknown>>) {
  return updates.find((u) => (u._meta as { terminal_exit?: unknown })?.terminal_exit !== undefined);
}

/** Distinct terminal_ids carried by terminal_output_delta updates, in order. */
function terminalDeltaIds(updates: Array<Record<string, unknown>>): string[] {
  const ids: string[] = [];
  for (const u of updates) {
    const id = (u._meta as { terminal_output_delta?: { terminal_id?: string } })
      ?.terminal_output_delta?.terminal_id;
    if (typeof id === "string" && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

describe("runLiveCommand", () => {
  it("streams stdout/stderr as terminal_output_delta chunks keyed to the toolCallId", async () => {
    const { client, updates } = makeClient();
    const child = new FakeChild();
    const spawnShell: SpawnShellFn = () => child as unknown as ChildProcess;
    const ctx: LiveBashContext = {
      sessionId: "s1",
      cwd: "/tmp",
      logger,
      client,
      spawnShell,
    };

    const p = runLiveCommand(ctx, "tc-1", "echo hi", 5000);
    child.stdout.emit("data", Buffer.from("a\n"));
    child.stderr.emit("data", Buffer.from("b\n"));
    child.stdout.emit("data", "c\n");
    child.emit("close", 0, null);
    const result = await p;

    expect(deltaTexts(updates)).toEqual(["a\n", "b\n", "c\n"]);
    // Every delta keys off the same ACP toolCallId.
    for (const u of updates) {
      if ((u._meta as { terminal_output_delta?: unknown })?.terminal_output_delta) {
        expect(u.toolCallId).toBe("tc-1");
      }
    }
    expect(result.output).toBe("a\nb\nc\n");
    expect(result.exitCode).toBe(0);
    expect(result.failed).toBe(false);

    const exit = exitUpdate(updates);
    expect(exit?.status).toBe("completed");
    expect((exit?._meta as { terminal_exit: { exit_code: number } }).terminal_exit.exit_code).toBe(
      0,
    );
  });

  it("marks a non-zero exit as failed with the exit code", async () => {
    const { client, updates } = makeClient();
    const child = new FakeChild();
    const ctx: LiveBashContext = {
      sessionId: "s1",
      cwd: "/tmp",
      logger,
      client,
      spawnShell: () => child as unknown as ChildProcess,
    };
    const p = runLiveCommand(ctx, "tc-2", "false", 5000);
    child.stderr.emit("data", "boom\n");
    child.emit("close", 3, null);
    const result = await p;

    expect(result.failed).toBe(true);
    expect(result.exitCode).toBe(3);
    const exit = exitUpdate(updates);
    expect(exit?.status).toBe("failed");
    expect((exit?._meta as { terminal_exit: { exit_code: number } }).terminal_exit.exit_code).toBe(
      3,
    );
  });

  it("kills the child and fails when the abort signal fires", async () => {
    const { client, updates } = makeClient();
    const child = new FakeChild();
    const controller = new AbortController();
    const ctx: LiveBashContext = {
      sessionId: "s1",
      cwd: "/tmp",
      logger,
      client,
      spawnShell: () => child as unknown as ChildProcess,
      killChild: (c) => c.kill(),
    };
    const p = runLiveCommand(ctx, "tc-3", "sleep 100", 5000, controller.signal);
    controller.abort();
    expect(child.killed).toBe(true);
    // The kill drives the child to close with a signal.
    child.emit("close", null, "SIGKILL");
    const result = await p;
    expect(result.failed).toBe(true);
    const exit = exitUpdate(updates);
    expect(exit?.status).toBe("failed");
  });

  it("kills the child and reports a timeout when it overruns", async () => {
    vi.useFakeTimers();
    try {
      const { client, updates } = makeClient();
      const child = new FakeChild();
      const ctx: LiveBashContext = {
        sessionId: "s1",
        cwd: "/tmp",
        logger,
        client,
        spawnShell: () => child as unknown as ChildProcess,
        killChild: (c) => c.kill(),
      };
      const p = runLiveCommand(ctx, "tc-4", "sleep 100", 1000);
      vi.advanceTimersByTime(1001);
      expect(child.killed).toBe(true);
      child.emit("close", null, "SIGKILL");
      const result = await p;
      expect(result.failed).toBe(true);
      expect(deltaTexts(updates).join("")).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails gracefully when spawn throws", async () => {
    const { client, updates } = makeClient();
    const ctx: LiveBashContext = {
      sessionId: "s1",
      cwd: "/tmp",
      logger,
      client,
      spawnShell: () => {
        throw new Error("ENOENT");
      },
    };
    const result = await runLiveCommand(ctx, "tc-5", "nope", 5000);
    expect(result.failed).toBe(true);
    expect(exitUpdate(updates)?.status).toBe("failed");
  });
});

describe("resolveShell", () => {
  it("uses cmd.exe on Windows when no bash is found", () => {
    const shell = resolveShell("win32", { ComSpec: "C:\\Windows\\cmd.exe" }, () => false);
    expect(shell.file).toBe("C:\\Windows\\cmd.exe");
    expect(shell.args).toContain("/c");
  });

  it("prefers git-bash on Windows when present", () => {
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
    const shell = resolveShell("win32", {}, (p) => p === bash);
    expect(shell.file).toBe(bash);
    expect(shell.args).toEqual(["-c"]);
  });

  it("uses /bin/bash on POSIX when present", () => {
    const shell = resolveShell("linux", {}, (p) => p === "/bin/bash");
    expect(shell.file).toBe("/bin/bash");
    expect(shell.args).toEqual(["-c"]);
  });

  it("falls back to /bin/sh on POSIX without bash", () => {
    const shell = resolveShell("linux", {}, () => false);
    expect(shell.file).toBe("/bin/sh");
  });
});

describe("createLiveBashTool handler", () => {
  it("does not spawn when permission is denied", async () => {
    const { client } = makeClient();
    const spawnShell = vi.fn();
    const ctx: LiveBashContext = {
      sessionId: "s1",
      cwd: "/tmp",
      logger,
      client,
      spawnShell: spawnShell as unknown as SpawnShellFn,
      resolveCorrelation: () => ({ toolCallId: "tc-perm", isSubagent: false }),
      ensurePermission: async () => false,
    };
    const t = createLiveBashTool(ctx);
    const result = await t.handler({ command: "rm -rf /" } as never, {});
    expect(spawnShell).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it("runs and returns aggregated output when permission is granted", async () => {
    const { client } = makeClient();
    const child = new FakeChild();
    const ctx: LiveBashContext = {
      sessionId: "s1",
      cwd: "/tmp",
      logger,
      client,
      spawnShell: () => child as unknown as ChildProcess,
      resolveCorrelation: () => ({ toolCallId: "tc-ok", isSubagent: false }),
      ensurePermission: async () => true,
    };
    const t = createLiveBashTool(ctx);
    const run = t.handler({ command: "echo hi" } as never, {});
    // Permission + spawn happen on the microtask queue; let them settle before
    // driving the fake child so the stdout/close listeners are attached.
    await new Promise((r) => setTimeout(r, 0));
    child.stdout.emit("data", "hi\n");
    child.emit("close", 0, null);
    const result = await run;
    expect(result.isError).toBe(false);
    expect((result.content[0] as { text: string }).text).toContain("hi");
  });

  it("streams main-agent output keyed to the correlated toolCallId", async () => {
    const { client, updates } = makeClient();
    const child = new FakeChild();
    const ctx: LiveBashContext = {
      sessionId: "s1",
      cwd: "/tmp",
      logger,
      client,
      spawnShell: () => child as unknown as ChildProcess,
      resolveCorrelation: () => ({ toolCallId: "toolu_real_42", isSubagent: false }),
      ensurePermission: async () => true,
    };
    const t = createLiveBashTool(ctx);
    const run = t.handler({ command: "echo hi" } as never, {});
    await new Promise((r) => setTimeout(r, 0));
    child.stdout.emit("data", "hi\n");
    child.emit("close", 0, null);
    await run;
    expect(terminalDeltaIds(updates)).toEqual(["toolu_real_42"]);
  });

  it("runs a sub-agent command SILENTLY — no terminal deltas leak to the top level", async () => {
    // Reproduces the bug: a sub-agent Bash correlated with isSubagent=true must
    // not emit any terminal_output_delta / terminal_exit (those would key off an
    // id with no top-level card and the renderer would spawn a phantom card).
    // The command still runs and its output returns via the tool_result.
    const { client, updates } = makeClient();
    const child = new FakeChild();
    const ctx: LiveBashContext = {
      sessionId: "s1",
      cwd: "/tmp",
      logger,
      client,
      spawnShell: () => child as unknown as ChildProcess,
      resolveCorrelation: () => ({ toolCallId: "toolu_sub_1", isSubagent: true }),
      ensurePermission: async () => true,
    };
    const t = createLiveBashTool(ctx);
    const run = t.handler({ command: "echo hi" } as never, {});
    await new Promise((r) => setTimeout(r, 0));
    child.stdout.emit("data", "hi\n");
    child.emit("close", 0, null);
    const result = await run;

    expect(updates).toEqual([]); // nothing streamed to the client
    expect(result.isError).toBe(false);
    expect((result.content[0] as { text: string }).text).toContain("hi"); // output still returned
  });

  it("runs SILENTLY when correlation is unavailable (no phantom top-level card)", async () => {
    const { client, updates } = makeClient();
    const child = new FakeChild();
    const ctx: LiveBashContext = {
      sessionId: "s1",
      cwd: "/tmp",
      logger,
      client,
      spawnShell: () => child as unknown as ChildProcess,
      resolveCorrelation: () => undefined,
      ensurePermission: async () => true,
    };
    const t = createLiveBashTool(ctx);
    const run = t.handler({ command: "echo hi" } as never, {});
    await new Promise((r) => setTimeout(r, 0));
    child.stdout.emit("data", "hi\n");
    child.emit("close", 0, null);
    const result = await run;

    expect(updates).toEqual([]);
    expect((result.content[0] as { text: string }).text).toContain("hi");
  });
});

describe("createLiveBashCorrelationStore", () => {
  it("resolves a registered command to its toolCallId and subagent flag", () => {
    const store = createLiveBashCorrelationStore();
    store.register("toolu_1", "ls", false);
    store.register("toolu_2", "pwd", true);
    expect(store.resolve("ls")).toEqual({ toolCallId: "toolu_1", isSubagent: false });
    expect(store.resolve("pwd")).toEqual({ toolCallId: "toolu_2", isSubagent: true });
  });

  it("returns undefined for an unknown command", () => {
    const store = createLiveBashCorrelationStore();
    expect(store.resolve("nope")).toBeUndefined();
  });

  it("consumes records FIFO so identical commands map to distinct ids", () => {
    const store = createLiveBashCorrelationStore();
    store.register("toolu_a", "echo hi", false);
    store.register("toolu_b", "echo hi", true);
    expect(store.resolve("echo hi")?.toolCallId).toBe("toolu_a");
    expect(store.resolve("echo hi")?.toolCallId).toBe("toolu_b");
    expect(store.resolve("echo hi")).toBeUndefined();
  });

  it("ignores a duplicate registration of the same toolUseId", () => {
    const store = createLiveBashCorrelationStore();
    store.register("toolu_x", "ls", false);
    store.register("toolu_x", "ls", true);
    expect(store.resolve("ls")?.isSubagent).toBe(false);
    expect(store.resolve("ls")).toBeUndefined();
  });
});

describe("createLiveBashPreToolUseHook", () => {
  it("records a main-agent Bash (no agent_id → isSubagent=false)", async () => {
    const store = createLiveBashCorrelationStore();
    const hook = createLiveBashPreToolUseHook(store, logger);
    await hook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
      "toolu_main",
    );
    expect(store.resolve("ls")).toEqual({ toolCallId: "toolu_main", isSubagent: false });
  });

  it("records a sub-agent Bash (agent_id present → isSubagent=true)", async () => {
    const store = createLiveBashCorrelationStore();
    const hook = createLiveBashPreToolUseHook(store, logger);
    await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "pwd" },
        agent_id: "agent-abc",
      },
      "toolu_sub",
    );
    expect(store.resolve("pwd")).toEqual({ toolCallId: "toolu_sub", isSubagent: true });
  });

  it("accepts the aliased MCP tool name too", async () => {
    const store = createLiveBashCorrelationStore();
    const hook = createLiveBashPreToolUseHook(store, logger);
    await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: LIVE_BASH_QUALIFIED_NAME,
        tool_input: { command: "whoami" },
      },
      "toolu_alias",
    );
    expect(store.resolve("whoami")?.toolCallId).toBe("toolu_alias");
  });

  it("ignores non-Bash tools, missing command, and missing tool_use id", async () => {
    const store = createLiveBashCorrelationStore();
    const hook = createLiveBashPreToolUseHook(store, logger);
    await hook(
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/a" } },
      "toolu_read",
    );
    await hook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} },
      "toolu_nocmd",
    );
    await hook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
      undefined,
    );
    await hook(
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
      "toolu_post",
    );
    expect(store.resolve("ls")).toBeUndefined();
  });
});

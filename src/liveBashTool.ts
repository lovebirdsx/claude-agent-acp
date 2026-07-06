import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as process from "node:process";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Logger } from "./acp-agent.js";

/** Local aliases so we don't reference the `NodeJS` namespace global (which the
 *  fork's eslint flags as undefined). */
type ProcessEnv = Record<string, string | undefined>;
type Platform = typeof process.platform;

/**
 * Live Bash tool — the executing half of "方案 B" (see
 * docs/plan/claude-shell-live-output-plan.md).
 *
 * The Claude Agent SDK runs its built-in `Bash` as a black box and only hands us
 * the whole stdout once, at the end, via `tool_result`. To stream output live
 * (like codex-acp) we redirect `Bash` to this in-process MCP tool with
 * `toolAliases: { Bash: 'mcp__universe-live-bash__bash' }`. The model still emits
 * a `Bash` tool_use (so the execute card renders unchanged), but execution runs
 * here: we spawn the command ourselves and, as each stdout/stderr chunk arrives,
 * push a `tool_call_update` carrying `_meta.terminal_output_delta` — the exact
 * wire shape codex uses and the renderer already consumes
 * (`readTerminalOutput` → `_accumulateTerminalOutput`).
 *
 * The tool stays free of any `acp-agent` internals: correlation (which ACP
 * `toolCallId` a run belongs to) and permission are injected as callbacks so the
 * agent wiring is thin and this file is unit-testable with mocks.
 */

/** The command name registered on the SDK MCP server. */
export const LIVE_BASH_SERVER_NAME = "universe-live-bash";
export const LIVE_BASH_TOOL_NAME = "bash";
/** Fully-qualified name used in `toolAliases` / MCP name resolution. */
export const LIVE_BASH_QUALIFIED_NAME = `mcp__${LIVE_BASH_SERVER_NAME}__${LIVE_BASH_TOOL_NAME}`;

/** Default hard cap so a runaway command can't stream forever (10 min). */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface LiveBashArgs {
  command: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
}

/**
 * Correlation for one live Bash run, resolved before execution from the
 * `PreToolUse` hook (which carries the model's `tool_use_id` and, for sub-agent
 * calls, an `agent_id`).
 */
export interface LiveBashCorrelation {
  /** The ACP `toolCallId` (== the model's `Bash` tool_use id) the renderer keys
   *  its execute card on. Terminal deltas must use this exact id. */
  toolCallId: string;
  /** True when this Bash originates from a sub-agent (Task worker). A sub-agent's
   *  Bash has no top-level card on the timeline, so streaming `terminal_output`
   *  against its id would land nowhere and the renderer would spawn a phantom
   *  top-level card (the leak). Sub-agent runs therefore stay silent; their
   *  output still folds into the sub-agent card via the normal `tool_result`. */
  isSubagent: boolean;
}

/** Minimal client surface: just the ability to push a session update. */
export interface LiveBashClient {
  sessionUpdate(params: { sessionId: string; update: Record<string, unknown> }): Promise<void>;
}

export interface LiveBashContext {
  sessionId: string;
  cwd: string;
  logger: Logger;
  client: LiveBashClient;
  /** Environment for the spawned shell. Defaults to `process.env`. */
  env?: ProcessEnv;
  /**
   * Resolve correlation for this run: the ACP `toolCallId` to key terminal
   * deltas on, plus whether it came from a sub-agent. Backed by the `PreToolUse`
   * hook, which fires before execution with the tool_use id + command (and an
   * `agent_id` for sub-agent calls). Returns undefined when no matching hook
   * record is found (correlation unavailable → run silently, no phantom card).
   */
  resolveCorrelation?(command: string): LiveBashCorrelation | undefined;
  /**
   * Ask the user to approve the command before it runs. Returning false denies
   * execution (nothing is spawned). Omit to skip the in-handler gate (only safe
   * when the SDK already routed the call through `canUseTool`).
   */
  ensurePermission?(toolCallId: string, command: string, signal: AbortSignal): Promise<boolean>;
  /** Test seam: override how the shell child process is created. */
  spawnShell?: SpawnShellFn;
  /** Test seam: override how a running child is killed (cancel/timeout). */
  killChild?(child: ChildProcess, logger: Logger): void;
}

export type SpawnShellFn = (command: string, cwd: string, env: ProcessEnv) => ChildProcess;

interface ShellInvocation {
  file: string;
  args: string[];
}

const WINDOWS_BASH_CANDIDATES = [
  process.env.SHELL,
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];

/**
 * Pick the shell used to run a Bash command. Claude emits bash syntax, so we
 * prefer a real bash (git-bash on Windows) and fall back to the platform shell.
 * Pure enough to unit test: platform + env + an injectable `exists` probe.
 */
export function resolveShell(
  platform: Platform = process.platform,
  env: ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): ShellInvocation {
  if (platform === "win32") {
    for (const candidate of WINDOWS_BASH_CANDIDATES) {
      if (candidate && exists(candidate)) {
        return { file: candidate, args: ["-c"] };
      }
    }
    const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
    return { file: comspec, args: ["/d", "/s", "/c"] };
  }
  if (exists("/bin/bash")) {
    return { file: "/bin/bash", args: ["-c"] };
  }
  return { file: "/bin/sh", args: ["-c"] };
}

function defaultSpawnShell(command: string, cwd: string, env: ProcessEnv): ChildProcess {
  const shell = resolveShell();
  return spawn(shell.file, [...shell.args, command], {
    cwd,
    env,
    // On POSIX, detach so we can signal the whole process group on cancel; on
    // Windows we kill the tree via taskkill instead (see killProcessTree).
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Kill a spawned command and its descendants. A bare `child.kill()` leaves
 * grandchildren orphaned (the git-bash → command chain on Windows, sub-shells on
 * POSIX), which on Windows has stalled `app.close()` in e2e before — kill the
 * whole tree. See memory: agent-binary-silent-download-e2e-fix.
 */
export function killProcessTree(child: ChildProcess, logger?: Logger): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
      }).on("error", () => child.kill("SIGKILL"));
    } else {
      // Negative pid → the process group created by `detached: true`.
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  } catch (err) {
    logger?.error(`[live-bash] killProcessTree failed: ${String(err)}`);
  }
}

function terminalDeltaUpdate(toolCallId: string, data: string): Record<string, unknown> {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId,
    _meta: {
      terminal_output_delta: { terminal_id: toolCallId, data },
    },
  };
}

function terminalExitUpdate(
  toolCallId: string,
  exitCode: number,
  signal: string | null,
  failed: boolean,
): Record<string, unknown> {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: failed ? "failed" : "completed",
    _meta: {
      terminal_exit: { terminal_id: toolCallId, exit_code: exitCode, signal },
    },
  };
}

function toText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Buffer) return chunk.toString("utf8");
  return String(chunk);
}

/** Read an AbortSignal from the SDK handler `extra`, if present. */
function extraSignal(extra: unknown): AbortSignal | undefined {
  const sig = (extra as { signal?: unknown } | undefined)?.signal;
  return sig instanceof AbortSignal ? sig : undefined;
}

/**
 * Execute one Bash command and resolve with the aggregated text + exit code once
 * it ends. When `stream` is true, output is also pushed live as terminal deltas
 * keyed to `toolCallId` (and a terminal_exit at the end). When false, the command
 * runs silently — output is only aggregated for the returned tool_result. Split
 * out from the tool handler so it can be exercised directly in tests.
 */
export function runLiveCommand(
  ctx: LiveBashContext,
  toolCallId: string,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
  stream: boolean = true,
): Promise<{ output: string; exitCode: number; failed: boolean }> {
  const env = ctx.env ?? process.env;
  const spawnShell = ctx.spawnShell ?? defaultSpawnShell;
  const killChild = ctx.killChild ?? killProcessTree;
  const logger = ctx.logger;

  const emit = (update: Record<string, unknown>) => {
    if (!stream) return;
    ctx.client
      .sessionUpdate({ sessionId: ctx.sessionId, update })
      .catch((err) => logger.error(`[live-bash] sessionUpdate failed: ${String(err)}`));
  };

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnShell(command, ctx.cwd, env);
    } catch (err) {
      const message = `Failed to start command: ${String(err)}`;
      logger.error(`[live-bash] spawn error: ${message}`);
      emit(terminalDeltaUpdate(toolCallId, message));
      emit(terminalExitUpdate(toolCallId, 1, null, true));
      resolve({ output: message, exitCode: 1, failed: true });
      return;
    }

    logger.log(`[live-bash] spawned pid=${child.pid ?? "?"} cmd=${command} stream=${stream}`);

    let aggregated = "";
    let settled = false;
    let timedOut = false;

    const push = (data: string) => {
      if (data.length === 0) return;
      aggregated += data;
      emit(terminalDeltaUpdate(toolCallId, data));
    };

    child.stdout?.on("data", (c) => push(toText(c)));
    child.stderr?.on("data", (c) => push(toText(c)));

    const timer = setTimeout(() => {
      timedOut = true;
      logger.error(`[live-bash] timeout after ${timeoutMs}ms, killing pid=${child.pid ?? "?"}`);
      killChild(child, logger);
    }, timeoutMs);

    const onAbort = () => {
      logger.log(`[live-bash] abort signalled, killing pid=${child.pid ?? "?"}`);
      killChild(child, logger);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (exitCode: number, sig: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      const failed = timedOut || sig !== null || exitCode !== 0;
      if (timedOut) push(`\n[timed out after ${timeoutMs}ms]\n`);
      logger.log(
        `[live-bash] exit pid=${child.pid ?? "?"} code=${exitCode} signal=${sig} failed=${failed}`,
      );
      emit(terminalExitUpdate(toolCallId, exitCode, sig, failed));
      resolve({ output: aggregated, exitCode, failed });
    };

    child.on("error", (err) => {
      push(`\n${String(err)}\n`);
      finish(1, null);
    });
    child.on("close", (code, sig) => finish(code ?? (sig ? 1 : 0), sig));
  });
}

/**
 * Build the SDK MCP tool that replaces the built-in Bash. `command` is required;
 * the other fields mirror `BashInput` and are passed through (we honor `timeout`,
 * and reject `run_in_background` as an explicit unsupported degrade for now).
 */
export function createLiveBashTool(ctx: LiveBashContext) {
  return tool(
    LIVE_BASH_TOOL_NAME,
    "Execute a bash command, streaming its output live to the terminal.",
    {
      command: z.string().describe("The command to execute"),
      timeout: z.number().optional().describe("Optional timeout in milliseconds (max 600000)"),
      description: z.string().optional().describe("What this command does"),
      run_in_background: z.boolean().optional().describe("Run the command in the background"),
    },
    async (args: LiveBashArgs, extra: unknown) => {
      const command = args.command;
      const signal = extraSignal(extra);

      // Correlation comes from the PreToolUse hook (fires before execution with
      // the tool_use id + agent_id). Two outcomes decide whether we stream:
      //   - main-agent Bash → correlation with a real toolCallId → stream live
      //     deltas keyed to that id (the renderer's execute card).
      //   - sub-agent Bash, or no correlation record → run SILENT. A sub-agent's
      //     Bash has no top-level card, so a streamed delta keyed to its id would
      //     make the renderer spawn a phantom top-level card (the leak this fixes
      //     — see docs/plan/claude-shell-live-output-plan.md §3.5). Output still
      //     reaches the sub-agent card through the normal tool_result path.
      const correlation = ctx.resolveCorrelation?.(command);
      const stream = correlation !== undefined && !correlation.isSubagent;
      // When silent, the id only labels aggregation/logs; nothing is sent with it.
      const toolCallId =
        correlation?.toolCallId ?? `live-bash-${ctx.sessionId}-${process.hrtime.bigint().toString(36)}`;
      ctx.logger.log(
        `[live-bash] toolCallId=${toolCallId} stream=${stream} ` +
          `(correlated=${correlation !== undefined}, subagent=${correlation?.isSubagent ?? "?"}) cmd=${command}`,
      );

      if (ctx.ensurePermission) {
        const abortSignal = signal ?? new AbortController().signal;
        const allowed = await ctx.ensurePermission(toolCallId, command, abortSignal);
        if (!allowed) {
          ctx.logger.log(`[live-bash] permission denied for: ${command}`);
          return {
            content: [{ type: "text", text: "Command was not approved by the user." }],
            isError: true,
          };
        }
      }

      const timeoutMs =
        typeof args.timeout === "number" && args.timeout > 0
          ? Math.min(args.timeout, DEFAULT_TIMEOUT_MS)
          : DEFAULT_TIMEOUT_MS;

      const { output, failed } = await runLiveCommand(
        ctx,
        toolCallId,
        command,
        timeoutMs,
        signal,
        stream,
      );

      return {
        content: [{ type: "text", text: output.length > 0 ? output : "(no output)" }],
        isError: failed,
      };
    },
  );
}

/** Wrap the live Bash tool in an SDK MCP server ready to merge into `mcpServers`. */
export function createLiveBashServer(ctx: LiveBashContext): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: LIVE_BASH_SERVER_NAME,
    version: "1.0.0",
    tools: [createLiveBashTool(ctx)],
  });
}

/**
 * Per-session correlation store bridging the `PreToolUse` hook and the live Bash
 * tool handler. The hook records each Bash's `{command, isSubagent}` before the
 * command runs; the handler looks it up by command to decide the ACP toolCallId
 * and whether to stream.
 *
 * Keyed by command string because the in-process MCP handler never receives the
 * model's tool_use id (MCP `tools/call` carries no tool_use block). A `consumed`
 * set makes repeated identical commands resolve to distinct hook records in FIFO
 * order instead of all matching the first one.
 */
export interface LiveBashCorrelationStore {
  /** Record a Bash tool_use seen by the PreToolUse hook. */
  register(toolUseId: string, command: string, isSubagent: boolean): void;
  /** Resolve (and consume) the earliest unconsumed record for `command`. */
  resolve(command: string): LiveBashCorrelation | undefined;
}

export function createLiveBashCorrelationStore(): LiveBashCorrelationStore {
  // Insertion-ordered; the earliest matching unconsumed entry wins.
  const records: Array<{ toolUseId: string; command: string; isSubagent: boolean }> = [];
  const consumed = new Set<string>();
  return {
    register(toolUseId, command, isSubagent) {
      if (consumed.has(toolUseId) || records.some((r) => r.toolUseId === toolUseId)) return;
      records.push({ toolUseId, command, isSubagent });
    },
    resolve(command) {
      for (const r of records) {
        if (r.command === command && !consumed.has(r.toolUseId)) {
          consumed.add(r.toolUseId);
          return { toolCallId: r.toolUseId, isSubagent: r.isSubagent };
        }
      }
      return undefined;
    },
  };
}

/** Read the string `command` from a PreToolUse hook's `tool_input`, if present. */
function bashCommandFromInput(toolInput: unknown): string | undefined {
  const cmd = (toolInput as { command?: unknown } | undefined)?.command;
  return typeof cmd === "string" ? cmd : undefined;
}

/**
 * PreToolUse hook that records every Bash tool_use into the correlation store
 * before it runs. Fires for both the main agent and sub-agents (a sub-agent call
 * carries `agent_id`), with the `tool_use_id` and `tool_input.command` atomic —
 * unlike the SDK's tool_use *cache*, whose sub-agent entries can arrive after the
 * aliased handler already executed. `tool_name` may be `Bash` or the alias
 * (`mcp__universe-live-bash__bash`) depending on where the CLI resolves it, so we
 * accept either as long as a string `command` is present.
 */
export function createLiveBashPreToolUseHook(
  store: LiveBashCorrelationStore,
  logger: Logger,
): (input: unknown, toolUseID: string | undefined) => Promise<{ continue: boolean }> {
  return async (input: unknown, toolUseID: string | undefined) => {
    const hook = input as
      | { hook_event_name?: string; tool_name?: string; tool_input?: unknown; agent_id?: unknown }
      | undefined;
    if (hook?.hook_event_name !== "PreToolUse") return { continue: true };
    const isBashName = hook.tool_name === "Bash" || hook.tool_name === LIVE_BASH_QUALIFIED_NAME;
    const command = bashCommandFromInput(hook.tool_input);
    if (!isBashName || command === undefined || !toolUseID) return { continue: true };
    const isSubagent = typeof hook.agent_id === "string" && hook.agent_id.length > 0;
    store.register(toolUseID, command, isSubagent);
    logger.log(
      `[live-bash] preToolUse recorded toolUseId=${toolUseID} subagent=${isSubagent} cmd=${command}`,
    );
    return { continue: true };
  };
}

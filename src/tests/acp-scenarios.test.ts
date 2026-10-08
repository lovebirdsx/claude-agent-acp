/**
 * The outbound ACP traffic of every scenario in `acp-scenarios/scenarios.ts`,
 * for two client profiles: a plain ACP client and Zed.
 *
 * - Recordings are JSON Lines: one outbound message on each line, with sorted
 *   keys. `normalize` in `harness.ts` replaces only exact run-specific values:
 *   the generated ids, the paths, and the argv and version of this process.
 * - Schema: every message is valid against the ACP schema of the SDK.
 * - Plain and Zed: the same information as origin/main
 *   (`acp-scenarios/origin-main/<profile>/<scenario>.jsonl`). `compare.ts`
 *   allows only the documented differences. These profiles have no golden
 *   files of their own. `origin-main/zed/` holds a scenario only when its
 *   recording differs from the plain client.
 * - Zed: the Zed conventions and the upstream `_meta` keys.
 *
 * To record the origin/main baseline again, copy `src/tests/acp-scenarios/`
 * and this file into a checkout of origin/main, and run this file there with
 * `ACP_SCENARIO_BASELINE_DIR=<dir>`. Then copy `<dir>/plain` and `<dir>/zed`
 * to `acp-scenarios/origin-main/`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assistantTurn,
  normalize,
  PROFILES,
  type Profile,
  type Recorded,
  resetIds,
  result,
  runScenario,
  type Scenario,
  type ScenarioRun,
  streamMessage,
  toolCall,
  toolResult,
} from "./acp-scenarios/harness.js";
import { SCENARIOS } from "./acp-scenarios/scenarios.js";
import {
  canonical,
  compareWithBaseline,
  UPSTREAM_AIR_CLAUDE_CODE_KEYS,
  UPSTREAM_AIR_META_KEYS,
} from "./acp-scenarios/compare.js";
import { EXTENSION_SESSION_UPDATES, validateRecorded } from "./acp-scenarios/schema.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  const harness = await import("./acp-scenarios/harness.js");
  return {
    ...actual,
    query: harness.mockedQuery,
    getSessionMessages: harness.mockedSessionMessages,
  };
});

// The recordings replace only the ids that the run generated, so the harness
// learns each id that `randomUUID` returns.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const harness = await import("./acp-scenarios/harness.js");
  return {
    ...actual,
    randomUUID: (...args: Parameters<typeof actual.randomUUID>) => {
      const id = actual.randomUUID(...args);
      harness.noteGeneratedId(id);
      return id;
    },
  };
});

const here = path.dirname(fileURLToPath(import.meta.url));
const baselineDir = process.env.ACP_SCENARIO_BASELINE_DIR;
const profiles = Object.values(PROFILES);
const runs = new Map<string, ScenarioRun>();
const key = (profile: Profile["name"], scenario: string) => `${profile}/${scenario}`;
let configDir: string;
let Agent: Parameters<typeof runScenario>[0];

beforeAll(async () => {
  // A run must not depend on the machine: no remote login, no Claude CLI, no
  // user settings, and the bypass mode also for root.
  for (const name of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "NO_BROWSER"]) {
    vi.stubEnv(name, "");
  }
  vi.stubEnv("CLAUDE_CODE_REMOTE", "");
  vi.stubEnv("ANTHROPIC_MODEL", "");
  vi.stubEnv("IS_SANDBOX", "1");
  vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "/usr/bin/false");
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-scenario-config-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
  const { ClaudeAcpAgent } = await import("../acp-agent.js");
  Agent = ClaudeAcpAgent;
  for (const profile of profiles) {
    for (const scenario of SCENARIOS) {
      resetIds();
      runs.set(
        key(profile.name, scenario.name),
        await runScenario(ClaudeAcpAgent, profile, scenario),
      );
    }
  }
}, 120_000);

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(configDir, { recursive: true, force: true });
});

/** A recording as JSON Lines: one message on each line, with sorted keys. */
function toJsonLines(recorded: Recorded[]): string {
  return recorded.map((record) => `${canonical(record)}\n`).join("");
}

function fromJsonLines(text: string): Recorded[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Recorded);
}

function run(profile: Profile["name"], scenario: string): ScenarioRun {
  const recorded = runs.get(key(profile, scenario));
  if (!recorded) throw new Error(`no run of ${scenario} for ${profile}`);
  return recorded;
}

function updates(recorded: Recorded[]): Record<string, any>[] {
  return recorded
    .filter((record) => record.kind === "sessionUpdate")
    .map((record) => (record.payload as { update: Record<string, any> }).update);
}

function toolCallReports(recorded: Recorded[], toolCallId?: string): Record<string, any>[] {
  return updates(recorded).filter(
    (update) =>
      (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
      (toolCallId === undefined || update.toolCallId === toolCallId),
  );
}

function permissionRequests(recorded: Recorded[]): Record<string, any>[] {
  return recorded
    .filter((record) => record.kind === "requestPermission")
    .map((record) => record.payload as Record<string, any>);
}

/** Every `_meta` object in a message, with the path to it. */
function metaObjects(value: unknown, at = "$"): { at: string; meta: Record<string, unknown> }[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => metaObjects(item, `${at}[${i}]`));
  return Object.entries(value as Record<string, unknown>).flatMap(([k, item]) => [
    ...(k === "_meta" && item && typeof item === "object" && !Array.isArray(item)
      ? [{ at: `${at}._meta`, meta: item as Record<string, unknown> }]
      : []),
    ...metaObjects(item, `${at}.${k}`),
  ]);
}

/** The origin/main recording of a scenario. Zed has a file only where it differs from the plain client. */
function readBaseline(profile: "plain" | "zed", scenario: string): string {
  const file = (name: string) =>
    path.join(here, "acp-scenarios", "origin-main", name, `${scenario}.jsonl`);
  return fs.readFileSync(
    profile === "zed" && !fs.existsSync(file("zed")) ? file("plain") : file(profile),
    "utf8",
  );
}

describe.runIf(baselineDir)("the origin/main baseline", () => {
  it("writes the recordings of the plain and Zed profiles", () => {
    for (const profile of ["plain", "zed"] as const) {
      fs.mkdirSync(path.join(baselineDir!, profile), { recursive: true });
      for (const scenario of SCENARIOS) {
        const text = toJsonLines(run(profile, scenario.name).normalized);
        if (profile === "zed" && text === toJsonLines(run("plain", scenario.name).normalized)) {
          continue;
        }
        fs.writeFileSync(path.join(baselineDir!, profile, `${scenario.name}.jsonl`), text);
      }
    }
  });
});

describe.skipIf(baselineDir)("ACP scenarios", () => {
  describe("normalize", () => {
    const cwd = "/tmp/acp-scenario-x";
    const session = "aaaaaaaa-0000-4000-8000-000000000001";
    const first = "bbbbbbbb-0000-4000-8000-000000000002";
    const second = "cccccccc-0000-4000-8000-000000000003";
    const scripted = "00000000-0000-4000-8000-00000000c001";
    const version = JSON.parse(
      fs.readFileSync(path.join(here, "..", "..", "package.json"), "utf8"),
    ).version;
    const argv = process.argv.slice(1);

    it("keeps a UUID that the run did not generate", () => {
      expect(normalize({ toolCallId: scripted }, cwd, session, new Set([first]))).toEqual({
        toolCallId: scripted,
      });
    });

    it("names the generated ids in the order of their first appearance", () => {
      const generated = new Set([first, second]);
      const reports = (ids: string[]) =>
        normalize(
          ids.map((id) => ({ sessionId: session, toolCallId: id })),
          cwd,
          session,
          generated,
        );
      expect(reports([first, first])).toEqual([
        { sessionId: "<session>", toolCallId: "<id-1>" },
        { sessionId: "<session>", toolCallId: "<id-1>" },
      ]);
      // A report that names another generated id, or the session id, still differs.
      expect(reports([first, second])).not.toEqual(reports([first, first]));
      expect(reports([first, session])).not.toEqual(reports([first, first]));
    });

    it("replaces only the exact argv prefix of this process", () => {
      expect(argv.length).toBeGreaterThan(0);
      expect(normalize({ args: [...argv, "--cli", "login"] }, cwd, session)).toEqual({
        args: ["<argv>", "--cli", "login"],
      });
      // An extra argument stays in the recording, before or after the prefix.
      expect(normalize({ args: [...argv, "--inspect", "--cli"] }, cwd, session)).toEqual({
        args: ["<argv>", "--inspect", "--cli"],
      });
      const before = ["--inspect", ...argv, "--cli"];
      const { args } = normalize({ args: before }, cwd, session) as { args: string[] };
      expect(args).toHaveLength(before.length);
      expect(args).not.toContain("<argv>");
      expect(normalize({ args: ["other.js", "--cli"] }, cwd, session)).toEqual({
        args: ["other.js", "--cli"],
      });
    });

    it("replaces only the version of this adapter and the path of this Node binary", () => {
      expect(normalize({ version, command: process.execPath }, cwd, session)).toEqual({
        version: "<version>",
        command: "<executable>",
      });
      expect(normalize({ version: "9.9.9", command: "/usr/bin/node" }, cwd, session)).toEqual({
        version: "9.9.9",
        command: "/usr/bin/node",
      });
    });

    it("keeps durations and other numbers", () => {
      expect(normalize({ durationMs: 7, totalDurationMs: 10 }, cwd, session)).toEqual({
        durationMs: 7,
        totalDurationMs: 10,
      });
    });
  });

  describe("schema check", () => {
    const none = new Set<string>();
    const elicitation = (url: string): Recorded => ({
      kind: "createElicitation",
      payload: {
        sessionId: "s",
        message: "Sign in",
        mode: "url",
        elicitationId: "e",
        url,
      },
    });
    const location = (line: number): Recorded => ({
      kind: "sessionUpdate",
      payload: {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "t",
          locations: [{ path: "/a.ts", line }],
        },
      },
    });

    it("rejects a value that breaks a standard format", () => {
      expect(validateRecorded(elicitation("https://example.com/login"), none)).toEqual([]);
      expect(validateRecorded(elicitation("not a uri"), none)).not.toEqual([]);
    });

    it("rejects a value that breaks an ACP integer format", () => {
      expect(validateRecorded(location(2 ** 32 - 1), none)).toEqual([]);
      expect(validateRecorded(location(2 ** 32), none)).not.toEqual([]);
    });
  });

  describe.each(profiles.map((profile) => profile.name))("%s ACP schema", (profile) => {
    // No scenario profile negotiates a draft ACP extension session update.
    const extensions = new Set<string>();
    it.each(SCENARIOS.map((scenario) => scenario.name))(
      "%s sends only valid messages",
      (scenario) => {
        const errors = run(profile, scenario).raw.flatMap((record) =>
          validateRecorded(record, extensions),
        );
        expect(errors).toEqual([]);
      },
    );
  });

  describe.each(profiles.map((profile) => profile.name))("%s session ids", (profile) => {
    // A profile declares the draft subagents extension to get native subagent
    // sessions, where a child session gets updates once `subagent_spawned`
    // announced it. Neither profile declares it.
    const nativeSubagents = false;
    it.each(SCENARIOS.map((scenario) => scenario.name))(
      "%s sends every session/update to the ACP session",
      (scenario) => {
        const { sessionId, raw } = run(profile, scenario);
        const sessions = new Set([sessionId]);
        const wrong: string[] = [];
        for (const record of raw) {
          if (record.kind !== "sessionUpdate") continue;
          const payload = record.payload as { sessionId: string; update: Record<string, any> };
          if (!sessions.has(payload.sessionId)) {
            wrong.push(`${payload.sessionId}: ${payload.update.sessionUpdate}`);
            continue;
          }
          if (nativeSubagents && payload.update.sessionUpdate === "subagent_spawned") {
            sessions.add(payload.update.subagentSessionId);
          }
        }
        expect(wrong).toEqual([]);
      },
    );
  });

  describe.each(["plain", "zed"] as const)("%s client", (profile) => {
    it.each(SCENARIOS.map((scenario) => scenario.name))(
      "%s carries the same information as origin/main",
      (scenario) => {
        const baseline = fromJsonLines(readBaseline(profile, scenario));
        expect(compareWithBaseline(baseline, run(profile, scenario).normalized)).toEqual([]);
      },
    );

    it.each(SCENARIOS.map((scenario) => scenario.name))(
      "%s sends no key that only AIR read upstream",
      (scenario) => {
        const found = metaObjects(run(profile, scenario).raw).flatMap(({ at, meta }) => [
          ...Object.keys(meta)
            .filter((k) => UPSTREAM_AIR_META_KEYS.has(k))
            .map((k) => `${at}.${k}`),
          ...Object.keys((meta.claudeCode as Record<string, unknown> | undefined) ?? {})
            .filter((k) => UPSTREAM_AIR_CLAUDE_CODE_KEYS.has(k))
            .map((k) => `${at}.claudeCode.${k}`),
        ]);
        expect(found).toEqual([]);
        expect(
          updates(run(profile, scenario).raw).filter((update) =>
            EXTENSION_SESSION_UPDATES.has(update.sessionUpdate),
          ),
        ).toEqual([]);
      },
    );
  });

  describe("plain client", () => {
    it("gets the Bash output as a code block and the description as content", () => {
      const reports = toolCallReports(run("plain", "bash-foreground").raw, "toolu_bash");
      expect(reports[0]).not.toHaveProperty("_meta.terminal_info");
      expect(reports.some((r) => JSON.stringify(r.content ?? []).includes("List files"))).toBe(
        true,
      );
      expect(reports.at(-2)).toMatchObject({
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "```console\na.ts\nb.ts\n```" } },
        ],
        rawOutput: "a.ts\nb.ts",
      });
    });

    it("gets the streamed partial input as rawInput, and the Write text in rawInput", () => {
      const reports = toolCallReports(run("plain", "write-new").raw, "toolu_write");
      expect(reports[0]).toMatchObject({ sessionUpdate: "tool_call", rawInput: {} });
      expect(reports.some((r) => r.rawInput?.file_path && !("content" in r.rawInput))).toBe(true);
      expect(reports.some((r) => r.rawInput?.content === "export const x = 1;\n")).toBe(true);
    });

    it("gets the whole tool call again in a permission request", () => {
      const [request] = permissionRequests(run("plain", "edit-with-permission").raw);
      expect(request.toolCall).toMatchObject({
        toolCallId: "toolu_edit",
        name: "Edit",
        status: "pending",
        kind: "edit",
        title: "Edit src/app.ts",
        rawInput: {
          old_string: "const value = 1;",
          new_string: "const value = 2;",
        },
        content: [{ type: "diff", oldText: "const value = 1;", newText: "const value = 2;" }],
      });
      expect(request).not.toHaveProperty("_meta");
    });

    it("gets the question of a single AskUserQuestion as the title", () => {
      const reports = toolCallReports(run("plain", "ask-user-question").raw, "toolu_ask");
      expect(reports.map((r) => r.title)).toContain("Which database?");
    });

    it("gets the upstream NotebookEdit rendering and the result text", () => {
      const reports = toolCallReports(run("plain", "notebook-edit").raw, "toolu_nb");
      expect(reports[0]).toMatchObject({ title: "NotebookEdit", kind: "other", content: [] });
      expect(reports.at(-1)).toMatchObject({
        status: "completed",
        rawOutput: "Updated cell cell-1 with print('hi')",
      });
    });

    it("gets every Task* plan, also a repeated one", () => {
      const plans = updates(run("plain", "task-create-update").raw).filter(
        (update) => update.sessionUpdate === "plan",
      );
      expect(plans.map((plan) => plan.entries[0]?.status)).toEqual([
        "pending",
        "pending",
        "in_progress",
        "completed",
        "completed",
      ]);
    });
  });

  describe("Zed", () => {
    const zed = (scenario: string) => run("zed", scenario).raw;

    it("keeps terminal_info, terminal_output, and terminal_exit", () => {
      const reports = toolCallReports(zed("bash-foreground"), "toolu_bash");
      expect(reports[0]).toMatchObject({
        sessionUpdate: "tool_call",
        content: [{ type: "terminal", terminalId: "toolu_bash" }],
        _meta: { terminal_info: { terminal_id: "toolu_bash" } },
      });
      expect(reports).toContainEqual(
        expect.objectContaining({
          _meta: { terminal_output: { terminal_id: "toolu_bash", data: "a.ts\nb.ts" } },
        }),
      );
      expect(reports).toContainEqual(
        expect.objectContaining({
          status: "completed",
          _meta: expect.objectContaining({
            terminal_exit: { terminal_id: "toolu_bash", exit_code: 0, signal: null },
          }),
        }),
      );
      for (const report of reports) {
        expect(report._meta ?? {}).not.toHaveProperty("terminal_output_delta");
      }
    });

    it("keeps the upstream claudeCode keys and the full PostToolUse toolResponse", () => {
      const reports = toolCallReports(zed("bash-foreground"), "toolu_bash");
      expect(reports[0]._meta.claudeCode).toEqual({ toolName: "Bash" });
      expect(reports.at(-1)?._meta.claudeCode).toEqual({
        toolName: "Bash",
        toolResponse: { stdout: "a.ts\nb.ts", stderr: "", interrupted: false, isImage: false },
      });
      const child = toolCallReports(zed("subagent-task-legacy"), "toolu_sub_read");
      expect(child[0]._meta.claudeCode).toEqual({
        toolName: "Read",
        parentToolUseId: "toolu_task",
      });
      // ACP does not merge `_meta` keys, so each update names the parent again.
      for (const report of child) {
        expect(report._meta.claudeCode).toMatchObject({
          toolName: "Read",
          parentToolUseId: "toolu_task",
        });
      }
      const [childRequest] = permissionRequests(zed("subagent-task-legacy"));
      expect(childRequest.toolCall._meta).toEqual({
        claudeCode: {
          toolName: "Bash",
          parentToolUseId: "toolu_task",
          clientMayAutoApproveOnce: true,
        },
      });
      const [mcpRequest] = permissionRequests(zed("mcp-tool"));
      expect(mcpRequest.toolCall._meta).toEqual({
        claudeCode: {
          toolName: "mcp__docs__search",
          mcpServer: { name: "docs", source: "project" },
          clientMayAutoApproveOnce: true,
        },
      });
    });

    it("keeps the full permission denial toolResponse", () => {
      const denial = toolCallReports(zed("permission-denied"), "toolu_denied").find(
        (report) => report.status === "failed",
      );
      expect(denial?._meta.claudeCode.toolResponse).toEqual({
        decisionReasonType: "rule",
        decisionReason: "Denied by rule Bash(rm:*)",
        message: "Permission to use Bash has been denied.",
      });
    });

    it("keeps the _claude/* keys", () => {
      const [elicitation] = zed("ask-user-question")
        .filter((record) => record.kind === "createElicitation")
        .map((record) => record.payload as Record<string, any>);
      const options = elicitation.requestedSchema.properties.question_0.oneOf;
      expect(options[0]._meta).toHaveProperty(["_claude/askUserQuestionOption"]);
      const usage = updates(zed("rate-limit-and-origin")).filter(
        (update) => update.sessionUpdate === "usage_update",
      );
      expect(usage.some((update) => update._meta?.["_claude/rateLimit"])).toBe(true);
      expect(usage.some((update) => update._meta?.["_claude/origin"])).toBe(true);
    });

    it("keeps promptQueueing and steering", () => {
      const initialize = zed("session-setup").find((record) => record.kind === "initialize")!
        .payload as Record<string, any>;
      expect(initialize.agentCapabilities._meta.claudeCode).toEqual({ promptQueueing: true });
      expect(initialize._meta).toEqual({ steering: { supported: true } });
    });

    it("sends terminal-auth commands that rerun this adapter with --cli", () => {
      // The raw traffic, because the recordings normalize the machine paths.
      const initialize = zed("session-setup").find((record) => record.kind === "initialize")!
        .payload as Record<string, any>;
      const argv = process.argv.slice(1);
      expect(initialize.authMethods).toEqual([
        expect.objectContaining({
          id: "claude-ai-login",
          args: ["--cli", "auth", "login", "--claudeai"],
          _meta: {
            "terminal-auth": {
              command: process.execPath,
              args: [...argv, "--cli", "auth", "login", "--claudeai"],
              label: "Claude Login",
            },
          },
        }),
        expect.objectContaining({
          id: "console-login",
          args: ["--cli", "auth", "login", "--console"],
          _meta: {
            "terminal-auth": {
              command: process.execPath,
              args: [...argv, "--cli", "auth", "login", "--console"],
              label: "Anthropic Console Login",
            },
          },
        }),
      ]);
    });
  });

  describe("ExitPlanMode with a plan file", () => {
    const plan = "# Plan\n1. Do it";
    /**
     * The CLI streams the input that the model wrote, which has no plan. The
     * complete message and canUseTool get the text and the path of the plan
     * file. The structured result names the file again. A client without the
     * retired AIR plan-file extension gets the whole input.
     */
    const planFileScenario = (): Scenario => ({
      name: "exit-plan-file",
      files: { "plans/plan.md": plan },
      turns: [
        async function* (ctx) {
          const planFilePath = path.join(ctx.cwd, "plans", "plan.md");
          const input = { plan, planFilePath };
          yield* streamMessage("msg_toolu_plan", [
            { type: "tool_use", id: "toolu_plan", name: "ExitPlanMode", input: {} },
          ]);
          yield* toolCall(
            ctx,
            { id: "toolu_plan", name: "ExitPlanMode", input },
            {
              ask: true,
              content: `User has approved your plan.\n\n## Approved Plan:\n${plan}`,
              structured: { plan, isAgent: false, filePath: planFilePath },
            },
          );
          yield result();
        },
      ],
    });

    it("sends the whole input and the plan text", async () => {
      for (const profile of [PROFILES.plain, PROFILES.zed]) {
        resetIds();
        const recorded = (await runScenario(Agent, profile, planFileScenario())).raw;
        const [request] = permissionRequests(recorded);
        expect(request.toolCall.rawInput).toEqual({ plan, planFilePath: expect.any(String) });
        expect(request.toolCall.content).toEqual([
          { type: "content", content: { type: "text", text: plan } },
        ]);
        const reports = toolCallReports(recorded, "toolu_plan");
        expect(reports.some((r) => r.rawInput?.plan === plan)).toBe(true);
      }
    });
  });

  it("keeps the full PostToolUse toolResponse of a Write", async () => {
    resetIds();
    const recorded = (await runScenario(Agent, PROFILES.plain, writtenFileScenario())).raw;
    const hook = toolCallReports(recorded, "toolu_write").find(
      (report) => report._meta?.claudeCode?.toolResponse !== undefined,
    );
    expect(hook?._meta?.claudeCode?.toolResponse).toMatchObject({
      type: "update",
      content: "export const x = 1;\n",
      originalFile: "export const x = 0;\n",
    });
  });

  it("replays a Write and an Edit from the transcript as diffs", async () => {
    resetIds();
    const replay = (await runScenario(Agent, PROFILES.plain, replayedEditsScenario())).raw;
    // A replay does not read old.ts: the disk shows a later state than the history.
    expect(toolCallReports(replay, "toolu_r_write")[0].content).toEqual([
      {
        type: "diff",
        path: expect.stringMatching(/old\.ts$/),
        oldText: null,
        newText: "export const x = 1;\n",
      },
    ]);
    expect(toolCallReports(replay, "toolu_r_edit")[0].content).toEqual([
      {
        type: "diff",
        path: expect.stringMatching(/app\.ts$/),
        oldText: "const value = 1;",
        newText: "const value = 2;",
      },
    ]);
  });
});

/** A Write that changes the file on disk before its PostToolUse hook runs. */
function writtenFileScenario(): Scenario {
  return {
    name: "write-on-disk",
    files: { "old.ts": "export const x = 0;\n" },
    turns: [
      async function* (ctx) {
        const file = path.join(ctx.cwd, "old.ts");
        const input = { file_path: file, content: "export const x = 1;\n" };
        yield* assistantTurn("msg_write", [
          { type: "tool_use", id: "toolu_write", name: "Write", input },
        ]);
        fs.writeFileSync(file, input.content);
        yield toolResult("toolu_write", `The file ${file} has been updated successfully.`);
        await ctx.postToolUse("toolu_write", "Write", input, {
          type: "update",
          filePath: file,
          content: input.content,
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ["-export const x = 0;", "+export const x = 1;"],
            },
          ],
          originalFile: "export const x = 0;\n",
        });
        yield result();
      },
    ],
  };
}

/** A session/load of a Write over an existing file and of an Edit. */
function replayedEditsScenario(): Scenario {
  return {
    name: "replayed-edits",
    files: { "old.ts": "export const x = 0;\n", "app.ts": "line 1\nconst value = 1;\n" },
    transcript: ({ cwd, sessionId }) => [
      {
        type: "user",
        uuid: "00000000-0000-4000-8000-00000000f001",
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { role: "user", content: "Change both files" },
      },
      {
        type: "assistant",
        uuid: "00000000-0000-4000-8000-00000000f002",
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          id: "msg_r_edits",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [
            {
              type: "tool_use",
              id: "toolu_r_write",
              name: "Write",
              input: { file_path: path.join(cwd, "old.ts"), content: "export const x = 1;\n" },
            },
            {
              type: "tool_use",
              id: "toolu_r_edit",
              name: "Edit",
              input: {
                file_path: path.join(cwd, "app.ts"),
                old_string: "const value = 1;",
                new_string: "const value = 2;",
              },
            },
          ],
        },
      },
    ],
    turns: [],
  };
}

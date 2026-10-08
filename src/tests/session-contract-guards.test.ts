/**
 * 生产入口（`session/load`、`unstable_forkSession`、`prompt`）的行为契约：断言
 * 出站 ACP 流量，而非内部 helper。直接调 helper 的同主题用例见
 * `replaySessionHistory across compaction` 与 `unstable_forkSession fork point`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionNotification } from "@agentclientprotocol/sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
import { COMPACTION_METHOD } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

/** 每用例独立的假 `~/.claude`：transcript 扫描与用户 settings 都不落到真实 home。 */
let configDir: string;
let chains: Record<string, Record<string, unknown>[]>;
let forkResult: { sessionId: string };

/** 后台 `getContextUsage` 的闸门：null = 立即返回 `DEFAULT_CONTEXT_USAGE`。
 *  `session/load` 之后的后台用量刷新靠它驱动合法交错，不靠 sleep。 */
let contextUsageGate: { promise: Promise<any>; release: (value?: any) => void } | null = null;

vi.mock("../paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../paths.js")>()),
  claudeConfigDir: () => configDir,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  const { DEFAULT_CONTEXT_USAGE, makeMockQuery } = await import("./helpers.js");
  return {
    ...actual,
    query: (_args: { prompt: unknown; options: Options }) =>
      makeMockQuery({
        initializationResult: async () => ({
          models: [
            { value: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", description: "Fast" },
          ],
        }),
        getContextUsage: () =>
          contextUsageGate ? contextUsageGate.promise : Promise.resolve(DEFAULT_CONTEXT_USAGE),
      }),
    getSessionMessages: vi.fn((sessionId: string) => Promise.resolve(chains[sessionId] ?? [])),
    forkSession: vi.fn(() => Promise.resolve(forkResult)),
  };
});

const { forkSession } = await import("@anthropic-ai/claude-agent-sdk");

async function writeTranscript(sessionId: string, lines: Record<string, unknown>[]): Promise<void> {
  const dir = path.join(configDir, "projects", "contract");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    "utf8",
  );
}

type Recorded =
  | { kind: "user" | "agent"; text: string }
  | { kind: "compaction"; phase: unknown }
  | { kind: "update"; update: Record<string, any> };

/** 记录文本块、压缩卡与其他 update。后台 `reconcileResumedSessionModel` 的
 *  `usage_update` 与回放本就竞态（session/load 从不 await 它），不属于本文件
 *  的契约，直接丢弃。 */
function recordingClient(): { client: AcpClient; events: Recorded[] } {
  const events: Recorded[] = [];
  const client = {
    sessionUpdate: async (notification: SessionNotification) => {
      const update = notification.update as Record<string, any>;
      if (
        (update.sessionUpdate === "user_message_chunk" ||
          update.sessionUpdate === "agent_message_chunk") &&
        update.content.type === "text"
      ) {
        events.push({
          kind: update.sessionUpdate === "user_message_chunk" ? "user" : "agent",
          text: update.content.text,
        });
      } else if (update.sessionUpdate !== "usage_update") {
        events.push({ kind: "update", update });
      }
    },
    extNotification: async (method: string, params: Record<string, unknown>) => {
      if (method === COMPACTION_METHOD) events.push({ kind: "compaction", phase: params.phase });
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as unknown as AcpClient;
  return { client, events };
}

const logger = { log: () => {}, error: () => {} };

/** 挂起后台 `getContextUsage`，返回放行函数。 */
function parkBackgroundContextUsage() {
  let release!: (value?: any) => void;
  const promise = new Promise<any>((resolve) => (release = resolve));
  contextUsageGate = { promise, release };
  return (value: any) => release(value);
}

let ClaudeAcpAgent: typeof ClaudeAcpAgentType;

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-contract-"));
  chains = {};
  forkResult = { sessionId: `forked-${randomUUID()}` };
  contextUsageGate = null;
  vi.resetModules();
  ClaudeAcpAgent = (await import("../acp-agent.js")).ClaudeAcpAgent;
});

afterEach(async () => {
  await fs.rm(configDir, { recursive: true, force: true });
});

describe("session/load 入口：压缩历史与 steering", () => {
  const STEERING = "STEERING_PROMPT_SURVIVES_LOAD";
  const SUMMARY = "SUMMARY_OF_DROPPED_HISTORY";

  /** 落盘 transcript：压缩边界前的历史、摘要、折叠进该 turn 的 steering 插话。 */
  const rawTranscript = (): Record<string, unknown>[] => [
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      message: { role: "user", content: "first question" },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      message: {
        id: "msg_1",
        role: "assistant",
        content: [{ type: "text", text: "first answer" }],
      },
    },
    {
      type: "system",
      subtype: "compact_boundary",
      uuid: "cb",
      parentUuid: null,
      logicalParentUuid: "a1",
      compactMetadata: { trigger: "auto", preTokens: 100000 },
    },
    {
      type: "user",
      uuid: "sum",
      parentUuid: "cb",
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: { role: "user", content: SUMMARY },
    },
    {
      type: "attachment",
      uuid: "q1",
      parentUuid: "sum",
      attachment: {
        type: "queued_command",
        prompt: [{ type: "text", text: STEERING }],
        source_uuid: "client-prompt-1",
        commandMode: "prompt",
        origin: { kind: "human" },
      },
    },
    {
      type: "user",
      uuid: "u2",
      parentUuid: "q1",
      message: { role: "user", content: "second question" },
    },
    {
      type: "assistant",
      uuid: "a2",
      parentUuid: "u2",
      message: {
        id: "msg_2",
        role: "assistant",
        content: [{ type: "text", text: "second answer" }],
      },
    },
  ];

  /** SDK 有效链：从摘要开始，attachment 行被 SDK 过滤掉。 */
  const effectiveChain = (sessionId: string): Record<string, unknown>[] => [
    {
      type: "user",
      uuid: "sum",
      session_id: sessionId,
      message: { role: "user", content: SUMMARY },
      parent_tool_use_id: null,
      parent_agent_id: null,
    },
    {
      type: "user",
      uuid: "u2",
      session_id: sessionId,
      message: { role: "user", content: "second question" },
      parent_tool_use_id: null,
      parent_agent_id: null,
    },
    {
      type: "assistant",
      uuid: "a2",
      session_id: sessionId,
      message: {
        id: "msg_2",
        role: "assistant",
        content: [{ type: "text", text: "second answer" }],
      },
      parent_tool_use_id: null,
      parent_agent_id: null,
    },
  ];

  it("从原始 transcript 恢复压缩前历史与 steering 插话", async () => {
    const sessionId = randomUUID();
    await writeTranscript(sessionId, rawTranscript());
    chains[sessionId] = effectiveChain(sessionId);

    const { client, events } = recordingClient();
    const agent = new ClaudeAcpAgent(client, logger);
    await agent.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] });

    expect(events).toEqual([
      { kind: "user", text: "first question" },
      { kind: "agent", text: "first answer" },
      { kind: "compaction", phase: "success" },
      { kind: "user", text: STEERING },
      { kind: "user", text: "second question" },
      { kind: "agent", text: "second answer" },
    ]);
    // 摘要只是标记，不得作为用户 turn 出现（有效链正是这样渲染它）。
    expect(events).not.toContainEqual({ kind: "user", text: SUMMARY });
  });

  /** 真实语料里 CLI 把 boundary 的显示序链接写坏的两种形态：`logicalParentUuid`
   *  为 `null`，或指向文件里不存在的 uuid。两者都曾让重建的回溯断在 boundary，
   *  恢复出的历史只剩最后一次 compact 之后。 */
  const unusableLinkTranscript = (link: string | null): Record<string, unknown>[] =>
    rawTranscript().map((row) =>
      row.subtype === "compact_boundary"
        ? {
            ...row,
            logicalParentUuid: link,
            compactMetadata: {
              trigger: "auto",
              preTokens: 100000,
              preservedSegment: { tailUuid: "a1" },
            },
          }
        : row,
    );

  it.each([null, "ghost-absent-from-file"])(
    "boundary 的显示序链接不可用（logicalParentUuid=%s）时经 preservedSegment.tailUuid 恢复",
    async (link) => {
      const sessionId = randomUUID();
      await writeTranscript(sessionId, unusableLinkTranscript(link));
      chains[sessionId] = effectiveChain(sessionId);

      const { client, events } = recordingClient();
      const agent = new ClaudeAcpAgent(client, logger);
      await agent.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] });

      expect(events).toEqual([
        { kind: "user", text: "first question" },
        { kind: "agent", text: "first answer" },
        { kind: "compaction", phase: "success" },
        { kind: "user", text: STEERING },
        { kind: "user", text: "second question" },
        { kind: "agent", text: "second answer" },
      ]);
      expect(events).not.toContainEqual({ kind: "user", text: SUMMARY });
    },
  );

  it("原始 transcript 缺失时降级到 SDK 有效链", async () => {
    const sessionId = randomUUID();
    chains[sessionId] = effectiveChain(sessionId);

    const { client, events } = recordingClient();
    const agent = new ClaudeAcpAgent(client, logger);
    await expect(
      agent.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] }),
    ).resolves.toBeDefined();

    // 降级后仍送达有效链的全部内容；压缩前历史按预期丢失，不抛错。
    expect(events).toContainEqual({ kind: "user", text: "second question" });
    expect(events).toContainEqual({ kind: "agent", text: "second answer" });
    expect(events).not.toContainEqual({ kind: "agent", text: "first answer" });
  });
});

describe("unstable_forkSession 入口：锚点解析与 fork 后配置", () => {
  it("常驻会话仍从磁盘解析锚点；fork 再 load 后模型与权限模式随源会话", async () => {
    const sourceId = `source-${randomUUID()}`;
    const forkedId = `forked-${randomUUID()}`;
    forkResult = { sessionId: forkedId };

    const { client } = recordingClient();
    const agent = new ClaudeAcpAgent(client, logger);
    // 常驻会话但 live messageId 表没有该锚点（prompt 来自更早的进程）→ 只能查盘。
    agent.sessions[sourceId] = mockSessionState({ cwd: process.cwd() }, undefined, sourceId);
    chains[sourceId] = [
      "uuid-user-1",
      "uuid-asst-1",
      "uuid-user-2",
      "uuid-asst-2",
      "uuid-user-3",
    ].map((uuid) => ({
      type: uuid.includes("asst") ? "assistant" : "user",
      uuid,
      session_id: sourceId,
      message: {},
    }));

    // SDK 复制出的 fork 落盘产物（本用例手工合成，只验证配置恢复，不验证复制本身）。
    await writeTranscript(forkedId, [
      {
        type: "user",
        uuid: "fk-user-1",
        parentUuid: null,
        permissionMode: "acceptEdits",
        origin: { kind: "human" },
        message: { role: "user", content: "first question" },
      },
      {
        type: "assistant",
        uuid: "fk-asst-1",
        parentUuid: "fk-user-1",
        message: {
          id: "msg_fk_1",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [{ type: "text", text: "first answer" }],
        },
      },
    ]);
    chains[forkedId] = [
      {
        type: "assistant",
        uuid: "fk-asst-1",
        session_id: forkedId,
        message: { id: "msg_fk_1", role: "assistant", model: "claude-haiku-4-5", content: [] },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
    ];

    const forked = await agent.unstable_forkSession({
      sessionId: sourceId,
      cwd: process.cwd(),
      _meta: { rewindTo: "uuid-user-3" },
    } as any);

    expect(forked).toEqual({ sessionId: forkedId });
    // 锚点是目标 turn 的前驱——绝不静默退化成整份复制。
    expect(forkSession).toHaveBeenCalledWith(sourceId, {
      dir: process.cwd(),
      upToMessageId: "uuid-asst-2",
    });
    // fork 只在磁盘落盘，客户端随后的 session/load 必须从盘重放。
    expect(agent.sessions[forkedId]).toBeUndefined();

    const loaded = await agent.loadSession({
      sessionId: forkedId,
      cwd: process.cwd(),
      mcpServers: [],
    });
    const optionOf = (id: string) => loaded.configOptions?.find((o) => o.id === id)?.currentValue;
    expect(optionOf("model")).toBe("claude-haiku-4-5");
    expect(optionOf("mode")).toBe("acceptEdits");
  });
});

describe.each(["Task", "Agent"])("非 AIR 子 agent（%s）", (tool) => {
  const LAUNCH = "toolu_launch";
  const CHILD = "toolu_child_read";

  it("保留编辑器可识别的工具元信息、归属正确且结束时完成", async () => {
    const events: Recorded[] = [];
    const agent = new ClaudeAcpAgent(
      {
        sessionUpdate: async (notification: SessionNotification) => {
          events.push({ kind: "update", update: notification.update as Record<string, any> });
        },
      } as unknown as AcpClient,
      logger,
    );
    const input = new Pushable<any>();
    const updates = (toolCallId: string) =>
      events
        .flatMap((event) => (event.kind === "update" ? [event.update] : []))
        .filter((update) => update.toolCallId === toolCallId);

    async function* turn() {
      const iter = input[Symbol.asyncIterator]();
      yield userEcho((await iter.next()).value);
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: "test-session",
        message: {
          id: "msg_launch",
          role: "assistant",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [
            {
              type: "tool_use",
              id: LAUNCH,
              name: tool,
              input: { description: "Explore", prompt: "Look around" },
            },
          ],
        },
      };
      yield {
        type: "assistant",
        parent_tool_use_id: LAUNCH,
        uuid: randomUUID(),
        session_id: "test-session",
        message: {
          id: "msg_child",
          role: "assistant",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "tool_use", id: CHILD, name: "Read", input: { file_path: "/x" } }],
        },
      };
      yield {
        type: "user",
        parent_tool_use_id: LAUNCH,
        uuid: randomUUID(),
        session_id: "test-session",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: CHILD, content: "body" }],
        },
      };
      yield {
        type: "user",
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: "test-session",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: LAUNCH, content: "Report." }],
        },
      };
      yield successfulResultMessage();
    }

    agent.sessions["test-session"] = mockSessionState({
      query: wrapQuery(turn()),
      input,
      cwd: "/test",
    });
    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "go" }] });

    // 启动调用保留编辑器识别子 agent 用的工具名，且不带 AIR 专属 meta。
    const launch = updates(LAUNCH)[0];
    expect(launch).toMatchObject({ sessionUpdate: "tool_call", name: tool });
    expect(launch?._meta?.claudeCode?.toolName).toBe(tool);
    expect(launch?._meta?.jetbrains).toBeUndefined();

    // 子调用归属到启动它的调用上。
    const child = updates(CHILD)[0];
    expect(child?._meta?.claudeCode?.parentToolUseId).toBe(LAUNCH);
    expect(child?._meta?.claudeCode?.toolName).toBe("Read");

    // 结果到达后启动调用收尾。
    expect(updates(LAUNCH).at(-1)).toMatchObject({ status: "completed" });
  });
});

describe("session/load 后台用量刷新（独立于 AIR 的能力契约）", () => {
  it("load 不等待后台控制请求；放行后只补发一条权威用量", async () => {
    const sessionId = randomUUID();
    // 会话模型来自 transcript：ANTHROPIC_MODEL / settings 都会走 reassert
    // 分支，本用例只验证「read-live-model」这条后台路径。父项目环境里的
    // auto-compact 上限会夹住窗口，这里显式清掉以便断言报告值本身。
    const savedModel = process.env.ANTHROPIC_MODEL;
    const savedClamp = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    chains[sessionId] = ["u1", "a1"].map((uuid) => ({
      type: uuid === "a1" ? "assistant" : "user",
      uuid,
      session_id: sessionId,
      message:
        uuid === "a1"
          ? { id: "msg_1", role: "assistant", model: "claude-haiku-4-5", content: [] }
          : { role: "user", content: "first question" },
      parent_tool_use_id: null,
      parent_agent_id: null,
    }));

    const usage: Record<string, any>[] = [];
    const client = {
      sessionUpdate: async (notification: SessionNotification) => {
        if (notification.update.sessionUpdate === "usage_update") {
          usage.push(notification.update as Record<string, any>);
        }
      },
      extNotification: async () => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient;
    const agent = new ClaudeAcpAgent(client, logger);
    const reconcile = vi.spyOn(agent as any, "reconcileResumedSessionModel");
    const releaseUsage = parkBackgroundContextUsage();

    try {
      await agent.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] });

      // 后台请求还挂着：load 已返回，客户端也还没有收到用量刷新。
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(usage).toEqual([]);

      // 报告窗口低于任何 auto-compact 上限，断言不受外部环境夹取影响。
      releaseUsage({ totalTokens: 4321, maxTokens: 100_000 });
      await reconcile.mock.results[0]?.value;

      // 窗口与占用取自这次后台报告，且只发这一条。
      expect(usage).toEqual([{ sessionUpdate: "usage_update", used: 4321, size: 100_000 }]);
      expect(agent.sessions[sessionId]?.contextWindowSize).toBe(100_000);
    } finally {
      contextUsageGate = null;
      if (savedModel !== undefined) process.env.ANTHROPIC_MODEL = savedModel;
      if (savedClamp !== undefined) process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = savedClamp;
    }
  });
});

describe("旧 AIR capability 输入不再启用专属协议", () => {
  const legacyAir = {
    _meta: {
      jetbrains: {
        air: {
          version: 1,
          capabilities: ["sessionFailure", "diffPatch", "planFile", "nativeSubagentSessions"],
        },
      },
    },
  };

  it("initialize 不回显 AIR 能力，也不广告 AIR 协议", async () => {
    const { client } = recordingClient();
    const agent = new ClaudeAcpAgent(client, logger);
    const response = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: legacyAir as any,
    });

    expect(JSON.stringify(response)).not.toContain("jetbrains");
    const sessionCapabilities = response.agentCapabilities?.sessionCapabilities as {
      subagents?: unknown;
    };
    expect(sessionCapabilities.subagents).toEqual({});
  });

  it("fork 忽略 AIR 的 fork 锚点，退回无锚点的 tip fork", async () => {
    const sourceId = `source-${randomUUID()}`;
    const { client } = recordingClient();
    const agent = new ClaudeAcpAgent(client, logger);

    await agent.unstable_forkSession({
      sessionId: sourceId,
      cwd: process.cwd(),
      _meta: {
        ...legacyAir._meta,
        jetbrains: { air: { version: 1, fork: { version: 1, messageId: "msg_1:segment:0" } } },
      },
    } as any);

    expect(forkSession).toHaveBeenCalledWith(sourceId, { dir: process.cwd() });
  });
});

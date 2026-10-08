import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { forkSession, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { messageIdForGrouping } from "../acp-agent.js";
import { resolveForkAnchor } from "../session-anchor.js";
import { rebuildTranscriptDisplayChain, type RawTranscriptEntry } from "../transcript-history.js";

/**
 * 锚定 fork 的真实 SDK 验收：不打 `vi.mock`，对一次性 `CLAUDE_CONFIG_DIR` 下的合成
 * transcript 跑真实的 `getSessionMessages` / `forkSession` 文件操作。
 *
 * SDK 在调用时才读 `CLAUDE_CONFIG_DIR`，但我们仍在 SDK import 之前（经 `vi.hoisted`）
 * 就把它指向私有根目录，避免 import 期缓存或模块级默认值碰到开发者的真实 `~/.claude`。
 * 全程不发 prompt、不读凭据——fork 路径只是纯 JSONL 复制。
 */
const TEST_CONFIG_DIR = vi.hoisted(() => {
  const tmp = process.env.TMPDIR ?? process.env.TEMP ?? "/tmp";
  const dir = `${tmp}/claude-acp-fork-sdk-${process.pid}-${Date.now()}`;
  process.env.CLAUDE_CONFIG_DIR = dir;
  return dir;
});

const PROJECT_DIR = path.join(TEST_CONFIG_DIR, "projects", "fork-sdk-fixture");

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U1 = "11111111-1111-4111-8111-111111111111";
const A1 = "22222222-2222-4222-8222-222222222222";
const U2 = "33333333-3333-4333-8333-333333333333";
const A2 = "44444444-4444-4444-8444-444444444444";
const U3 = "55555555-5555-4555-8555-555555555555";
const PROGRESS = "66666666-6666-4666-8666-666666666666";
const SIDECHAIN = "77777777-7777-4777-8777-777777777777";
const ATTACHMENT = "88888888-8888-4888-8888-888888888888";
const FOLDED_PROMPT_ID = "acp-steered-1";

const COMPACT_SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C_U1 = "c1111111-1111-4111-8111-111111111111";
const C_A1 = "c2222222-2222-4222-8222-222222222222";
const C_BOUNDARY = "c3333333-3333-4333-8333-333333333333";
const C_SUMMARY = "c4444444-4444-4444-8444-444444444444";
const C_U2 = "c5555555-5555-4555-8555-555555555555";
const C_A2 = "c6666666-6666-4666-8666-666666666666";
const C_U3 = "c7777777-7777-4777-8777-777777777777";

type Entry = Record<string, unknown>;

function user(uuid: string, parentUuid: string | null, text: string, extra: Entry = {}): Entry {
  return {
    type: "user",
    uuid,
    parentUuid,
    sessionId: SESSION_ID,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
    ...extra,
  };
}

function assistant(uuid: string, parentUuid: string | null, apiId: string, text: string): Entry {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    sessionId: SESSION_ID,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      id: apiId,
      type: "message",
      role: "assistant",
      model: "claude",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}

/** 含 folded steering prompt、progress 行与 sidechain 行的线性 transcript——正是 fork
 *  必须丢弃 / 重映射的形态。顺序模仿真实 transcript：steering prompt 折进运行中的
 *  turn（写在下一个 user turn 之前），progress 行可以成为下一个 turn 的 parent。 */
function linearTranscript(): Entry[] {
  return [
    user(U1, null, "first"),
    assistant(A1, U1, "api-1", "answer one"),
    user(U2, A1, "second"),
    assistant(A2, U2, "api-2", "answer two"),
    {
      type: "attachment",
      uuid: ATTACHMENT,
      parentUuid: A2,
      sessionId: SESSION_ID,
      timestamp: "2026-01-01T00:00:03.000Z",
      attachment: { type: "queued_command", source_uuid: FOLDED_PROMPT_ID, prompt: "steer" },
    },
    {
      type: "progress",
      uuid: PROGRESS,
      parentUuid: A2,
      sessionId: SESSION_ID,
      timestamp: "2026-01-01T00:00:02.000Z",
      data: {},
    },
    user(U3, PROGRESS, "third"),
    { ...assistant(SIDECHAIN, A2, "api-side", "side task"), isSidechain: true },
  ];
}

/** 显示历史跨越 compaction 边界的 transcript。 */
function compactTranscript(): Entry[] {
  return [
    { ...user(C_U1, null, "before one"), sessionId: COMPACT_SESSION_ID },
    { ...assistant(C_A1, C_U1, "api-c1", "before answer"), sessionId: COMPACT_SESSION_ID },
    {
      type: "system",
      subtype: "compact_boundary",
      uuid: C_BOUNDARY,
      parentUuid: null,
      logicalParentUuid: C_A1,
      sessionId: COMPACT_SESSION_ID,
      timestamp: "2026-01-01T00:00:02.000Z",
      compactMetadata: { trigger: "auto", preTokens: 100, postTokens: 50 },
    },
    {
      ...user(C_SUMMARY, C_BOUNDARY, "summary", { isCompactSummary: true }),
      sessionId: COMPACT_SESSION_ID,
    },
    { ...user(C_U2, C_SUMMARY, "after one"), sessionId: COMPACT_SESSION_ID },
    { ...assistant(C_A2, C_U2, "api-c2", "after answer"), sessionId: COMPACT_SESSION_ID },
    { ...user(C_U3, C_A2, "after two"), sessionId: COMPACT_SESSION_ID },
  ];
}

function writeTranscript(sessionId: string, entries: Entry[]): string {
  mkdirSync(PROJECT_DIR, { recursive: true });
  const file = path.join(PROJECT_DIR, `${sessionId}.jsonl`);
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  return file;
}

function readEntries(file: string): Entry[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Entry);
}

/** 镜像 `ClaudeAcpAgent.readTranscriptEntries` 的原始 transcript 读取器。 */
function readRawEntries(file: string): RawTranscriptEntry[] {
  return readEntries(file).filter(
    (entry) => typeof entry["uuid"] === "string",
  ) as unknown as RawTranscriptEntry[];
}

function forkedFile(newSessionId: string): string {
  return path.join(PROJECT_DIR, `${newSessionId}.jsonl`);
}

/** fork 的消息行（去掉末尾合成的 `custom-title`）。 */
function forkedMessages(file: string): Entry[] {
  return readEntries(file).filter((entry) => entry["type"] !== "custom-title");
}

beforeAll(() => {
  mkdirSync(PROJECT_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  if (process.env.CLAUDE_CONFIG_DIR === TEST_CONFIG_DIR) delete process.env.CLAUDE_CONFIG_DIR;
});

describe("forkSession over a real transcript file", () => {
  it("copies the tip into a new session and leaves the source byte-identical", async () => {
    const source = writeTranscript(SESSION_ID, linearTranscript());
    const before = readFileSync(source);

    const forked = await forkSession(SESSION_ID);

    expect(forked.sessionId).not.toBe(SESSION_ID);
    expect(readFileSync(source).equals(before)).toBe(true);
    const messages = forkedMessages(forkedFile(forked.sessionId));
    expect(messages.map((entry) => entry["forkedFrom"])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: SESSION_ID, messageUuid: U1 }),
        expect.objectContaining({ sessionId: SESSION_ID, messageUuid: A2 }),
      ]),
    );
  });

  it("slices up to and INCLUDING upToMessageId, dropping the later turn", async () => {
    writeTranscript(SESSION_ID, linearTranscript());

    const forked = await forkSession(SESSION_ID, { upToMessageId: A2 });

    const messages = forkedMessages(forkedFile(forked.sessionId));
    const originals = messages.map((entry) => (entry["forkedFrom"] as Entry)["messageUuid"]);
    expect(originals).toContain(A2);
    // U3（更晚的 turn）不得再出现在切片里。
    expect(originals).not.toContain(U3);
  });

  it("remaps ids, drops progress/sidechain rows and keeps the folded source_uuid", async () => {
    writeTranscript(SESSION_ID, linearTranscript());

    const forked = await forkSession(SESSION_ID);
    const messages = forkedMessages(forkedFile(forked.sessionId));

    const originalUuids = new Set([U1, A1, U2, A2, U3, PROGRESS, SIDECHAIN, ATTACHMENT]);
    const newUuids = new Set(messages.map((entry) => entry["uuid"] as string));
    for (const entry of messages) {
      const uuid = entry["uuid"] as string;
      expect(uuid).toBeTypeOf("string");
      expect(originalUuids.has(uuid)).toBe(false);
    }

    // parentUuid 链重映射到新 uuid，且绝不悬挂。
    for (const entry of messages) {
      const parent = entry["parentUuid"];
      if (parent !== null && parent !== undefined)
        expect(newUuids.has(parent as string)).toBe(true);
    }

    // progress 与 sidechain 行被整体丢弃。
    const keptOriginals = messages.map((entry) => (entry["forkedFrom"] as Entry)["messageUuid"]);
    expect(keptOriginals).not.toContain(PROGRESS);
    expect(keptOriginals).not.toContain(SIDECHAIN);

    // folded steering prompt 保留客户端 uuid（回放靠它重新锚定）。
    const attachment = messages.find(
      (entry) => (entry["attachment"] as Entry | undefined)?.["type"] === "queued_command",
    );
    expect((attachment?.["attachment"] as Entry)["source_uuid"]).toBe(FOLDED_PROMPT_ID);

    // U3 的 parent 是被丢弃的 progress 行 → 它改挂到 A2 的新 uuid。
    const u3 = messages.find((entry) => (entry["forkedFrom"] as Entry)["messageUuid"] === U3);
    const a2 = messages.find((entry) => (entry["forkedFrom"] as Entry)["messageUuid"] === A2);
    expect(u3?.["parentUuid"]).toBe(a2?.["uuid"]);
  });

  it("preserves the compaction-crossing display chain in the fork", async () => {
    writeTranscript(COMPACT_SESSION_ID, compactTranscript());

    const forked = await forkSession(COMPACT_SESSION_ID);
    const messages = forkedMessages(forkedFile(forked.sessionId));

    // boundary 的逻辑链重映射到新的压缩前 uuid，显示链因此能跨过它，完整历史得以保留。
    const chain = rebuildTranscriptDisplayChain(messages as unknown as RawTranscriptEntry[]);
    expect(chain).toBeDefined();
    expect(chain?.map((entry) => entry.type)).toEqual([
      "user",
      "assistant",
      "system",
      "user",
      "user",
      "assistant",
      "user",
    ]);
    const boundary = chain?.find((entry) => entry.subtype === "compact_boundary");
    const firstAssistant = chain?.[1];
    expect(boundary?.logicalParentUuid).toBe(firstAssistant?.uuid);

    // 核对：SDK 自己给该 fork 的有效链就是压缩后的尾部。
    const effective = await getSessionMessages(forked.sessionId);
    expect(effective).toHaveLength(4);
  });
});

describe("resolveForkAnchor feeding the real SDK fork", () => {
  function resolveWithRealReaders(sessionId: string, file: string, messageId: string) {
    return resolveForkAnchor({
      sessionId,
      messageId,
      liveUuid: undefined,
      dir: undefined,
      readChain: (dir) => getSessionMessages(sessionId, dir !== undefined ? { dir } : {}),
      readRawEntries: async () => readRawEntries(file),
      messageIdForGrouping,
    });
  }

  it("resolves the predecessor of a user-turn anchor and slices the real fork there", async () => {
    const file = writeTranscript(SESSION_ID, linearTranscript());

    // U3 是 user turn：它的 uuid 就是客户端持有的 ACP messageId。
    const { upToMessageId, resolution } = await resolveWithRealReaders(SESSION_ID, file, U3);
    expect(upToMessageId).toBe(A2);
    expect(resolution).toBe("active");

    const forked = await forkSession(SESSION_ID, { upToMessageId });
    const originals = forkedMessages(forkedFile(forked.sessionId)).map(
      (entry) => (entry["forkedFrom"] as Entry)["messageUuid"],
    );
    expect(originals).toContain(A2);
    expect(originals).not.toContain(U3);
  });

  it("resolves a folded steering anchor to its attachment parent", async () => {
    const file = writeTranscript(SESSION_ID, linearTranscript());

    const { upToMessageId, resolution } = await resolveWithRealReaders(
      SESSION_ID,
      file,
      FOLDED_PROMPT_ID,
    );
    expect(upToMessageId).toBe(A2);
    expect(resolution).toBe("folded");

    const forked = await forkSession(SESSION_ID, { upToMessageId });
    const kept = forkedMessages(forkedFile(forked.sessionId)).map(
      (entry) => (entry["forkedFrom"] as Entry)["messageUuid"],
    );
    // folded prompt 及其之后的行都留在 fork 之外。
    expect(kept).not.toContain(FOLDED_PROMPT_ID);
    expect(kept).not.toContain(U3);
    expect(kept).not.toContain(ATTACHMENT);
  });

  it("errors on an unresolvable anchor instead of producing a whole-session copy", async () => {
    const file = writeTranscript(SESSION_ID, linearTranscript());
    await expect(resolveWithRealReaders(SESSION_ID, file, "no-such-message-id")).rejects.toThrow(
      /not found/i,
    );
  });

  it("errors on a first-message anchor that has no predecessor", async () => {
    const file = writeTranscript(SESSION_ID, linearTranscript());
    await expect(resolveWithRealReaders(SESSION_ID, file, U1)).rejects.toThrow(/first message/i);
  });
});

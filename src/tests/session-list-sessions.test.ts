import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentSideConnection, ListSessionsRequest } from "@agentclientprotocol/sdk";
import type { ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";

const { listSessionsSpy, getSessionMessagesSpy } = vi.hoisted(() => ({
  listSessionsSpy: vi.fn(),
  getSessionMessagesSpy: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  return {
    ...actual,
    listSessions: listSessionsSpy,
    getSessionMessages: getSessionMessagesSpy,
  };
});

function createMockClient(): AgentSideConnection {
  return {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as unknown as AgentSideConnection;
}

const REQ: ListSessionsRequest = { cwd: "/proj" } as ListSessionsRequest;

describe("listSessions updatedAt", () => {
  let agent: ClaudeAcpAgentType;

  beforeEach(async () => {
    vi.resetModules();
    listSessionsSpy.mockReset();
    getSessionMessagesSpy.mockReset();
    const acpAgent = await import("../acp-agent.js");
    agent = new acpAgent.ClaudeAcpAgent(createMockClient());
  });

  // The whole point of the fix: a read-only `session/load` bumps the JSONL file
  // mtime, so updatedAt must come from message content, not lastModified.
  it("uses the last real message timestamp, not the file mtime", async () => {
    const fileMtime = Date.parse("2026-06-01T10:00:00.000Z");
    const lastMsgTs = "2026-05-20T08:30:00.000Z";
    listSessionsSpy.mockResolvedValue([
      {
        sessionId: "s1",
        cwd: "/proj",
        summary: "Hello",
        lastModified: fileMtime,
        createdAt: Date.parse("2026-05-01T00:00:00.000Z"),
      },
    ]);
    getSessionMessagesSpy.mockResolvedValue([
      { type: "user", timestamp: "2026-05-20T08:00:00.000Z" },
      { type: "assistant", timestamp: lastMsgTs },
    ]);

    const res = await agent.listSessions(REQ);

    expect(res.sessions).toHaveLength(1);
    expect(res.sessions[0].updatedAt).toBe(new Date(lastMsgTs).toISOString());
    expect(res.sessions[0].updatedAt).not.toBe(new Date(fileMtime).toISOString());
  });

  it("takes the max timestamp across messages regardless of order", async () => {
    listSessionsSpy.mockResolvedValue([
      { sessionId: "s1", cwd: "/proj", summary: "x", lastModified: 0 },
    ]);
    getSessionMessagesSpy.mockResolvedValue([
      { type: "assistant", timestamp: "2026-05-20T08:30:00.000Z" },
      { type: "user", timestamp: "2026-05-20T08:00:00.000Z" },
    ]);

    const res = await agent.listSessions(REQ);

    expect(res.sessions[0].updatedAt).toBe(new Date("2026-05-20T08:30:00.000Z").toISOString());
  });

  it("falls back to createdAt for an empty session", async () => {
    const createdAt = Date.parse("2026-05-01T00:00:00.000Z");
    listSessionsSpy.mockResolvedValue([
      {
        sessionId: "s1",
        cwd: "/proj",
        summary: "x",
        lastModified: Date.parse("2026-06-01T10:00:00.000Z"),
        createdAt,
      },
    ]);
    getSessionMessagesSpy.mockResolvedValue([]);

    const res = await agent.listSessions(REQ);

    expect(res.sessions[0].updatedAt).toBe(new Date(createdAt).toISOString());
  });

  it("falls back to mtime when getSessionMessages throws", async () => {
    const mtime = Date.parse("2026-06-01T10:00:00.000Z");
    listSessionsSpy.mockResolvedValue([
      { sessionId: "s1", cwd: "/proj", summary: "x", lastModified: mtime },
    ]);
    getSessionMessagesSpy.mockRejectedValue(new Error("boom"));

    const res = await agent.listSessions(REQ);

    expect(res.sessions[0].updatedAt).toBe(new Date(mtime).toISOString());
  });

  it("skips sessions without a cwd", async () => {
    listSessionsSpy.mockResolvedValue([
      { sessionId: "s1", summary: "x", lastModified: 0 },
      { sessionId: "s2", cwd: "/proj", summary: "y", lastModified: 0 },
    ]);
    getSessionMessagesSpy.mockResolvedValue([
      { type: "user", timestamp: "2026-05-20T08:00:00.000Z" },
    ]);

    const res = await agent.listSessions(REQ);

    expect(res.sessions.map((s) => s.sessionId)).toEqual(["s2"]);
  });
});

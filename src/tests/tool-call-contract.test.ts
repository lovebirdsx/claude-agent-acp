import { describe, expect, it } from "vitest";
import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import { AcpClient, toAcpNotifications, ToolUseCache } from "../acp-agent.js";
import { ClientCapabilities as ToolCallCapabilities } from "../tool-calls/client-capabilities.js";
import { ToolCallFieldTracker } from "../tool-calls/field-tracker.js";
import { AcpToolCallRenderer } from "../tool-calls/renderer.js";

const logger = { log: () => {}, error: () => {} };

/** The Zed terminal conventions: a terminal snapshot channel. */
const terminal: ClientCapabilities = { _meta: { terminal_output: true } };

/** A terminal client that renders output deltas instead of snapshots. */
const terminalDelta: ClientCapabilities = {
  _meta: { terminal_output: true, terminal_output_delta: true },
};

/** A plain ACP client: no terminal extension, no v2. */
const plain: ClientCapabilities = {};

function report(
  capabilities: ClientCapabilities,
  name: string,
  input: Record<string, unknown>,
  result?: { content: unknown; is_error?: boolean; structured?: unknown },
) {
  const cache: ToolUseCache = {};
  const map = (chunk: unknown, role: "assistant" | "user", toolUseResult?: unknown) =>
    toAcpNotifications([chunk] as any, role, "s", cache, {} as AcpClient, logger, {
      registerHooks: false,
      clientCapabilities: capabilities,
      cwd: "/work",
      toolUseResult,
    }).map((notification) => notification.update as any);
  const call = map({ type: "tool_use", id: "t", name, input }, "assistant");
  const updates = result
    ? map(
        {
          type: "tool_result",
          tool_use_id: "t",
          content: result.content,
          ...(result.is_error ? { is_error: true } : {}),
        },
        "user",
        result.structured,
      )
    : [];
  return { call: call[0], updates };
}

describe("ClientCapabilities", () => {
  it("reads the terminal conventions from the client's own _meta", () => {
    expect(
      ToolCallCapabilities.from({ _meta: { terminal_output: true, terminal_output_delta: true } }),
    ).toMatchObject({ terminalOutput: true, terminalOutputDelta: true, v2: false });
  });

  it("ignores unknown _meta keys", () => {
    // A client that advertises keys the adapter retired gets no capability.
    const unknown = {
      _meta: {
        rawInputRendering: true,
        jetbrains: { air: { version: 1, capabilities: ["diffPatch", "planFile"] } },
      },
    } as unknown as ClientCapabilities;
    expect(ToolCallCapabilities.from(unknown)).toMatchObject({
      terminalOutput: false,
      terminalOutputDelta: false,
      v2: false,
    });
  });
});

describe("the ACP tool call contract", () => {
  describe("Bash", () => {
    const input = { command: "ls", description: "List files" };

    it("keeps the Zed terminal conventions", () => {
      const { call, updates } = report(terminal, "Bash", input, { content: "a\nb" });
      expect(call).toMatchObject({
        title: "ls",
        kind: "execute",
        content: [{ type: "terminal", terminalId: "t" }],
        rawInput: input,
        _meta: { terminal_info: { terminal_id: "t" } },
      });
      expect(updates).toEqual([
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "t",
          _meta: { terminal_output: { terminal_id: "t", data: "a\nb" } },
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "t",
          status: "completed",
          content: [{ type: "terminal", terminalId: "t" }],
          _meta: {
            claudeCode: { toolName: "Bash" },
            terminal_exit: { terminal_id: "t", exit_code: 0, signal: null },
          },
        },
      ]);
    });

    it("appends output deltas for a client that negotiated them", () => {
      const { updates } = report(terminalDelta, "Bash", input, { content: "a" });
      expect(updates[0]._meta).toEqual({
        terminal_output_delta: { terminal_id: "t", data: "a" },
      });
    });

    it("shows one display copy of the description without a terminal", () => {
      const { call, updates } = report(plain, "Bash", input, { content: "a" });
      expect(call.content).toEqual([
        { type: "content", content: { type: "text", text: "List files" } },
      ]);
      expect(updates[0].content).toEqual([
        { type: "content", content: { type: "text", text: "```console\na\n```" } },
      ]);
    });
  });

  it("shows the Read text as content", () => {
    const { call, updates } = report(plain, "Read", { file_path: "/work/a.ts" }, { content: "x" });
    expect(call).toMatchObject({ title: "Read a.ts", kind: "read" });
    expect(updates[0].content).toEqual([
      { type: "content", content: { type: "text", text: "```\nx\n```" } },
    ]);
  });

  it("keeps the Read error text", () => {
    const { updates } = report(
      terminal,
      "Read",
      { file_path: "/work/a.ts" },
      { content: "File does not exist.", is_error: true },
    );
    expect(updates[0].status).toBe("failed");
    expect(updates[0].content).toBeDefined();
  });

  it("keeps the Write file text only in the diff", () => {
    const input = { file_path: "/work/a.ts", content: "text" };
    const { call } = report(terminal, "Write", input);
    expect(call.rawInput).toEqual({ file_path: "/work/a.ts", content: "text" });
    expect(call.content).toEqual([
      { type: "diff", path: "/work/a.ts", oldText: null, newText: "text" },
    ]);
  });

  it("keeps the Write file text of an alias key only in the diff", () => {
    for (const input of [
      { path: "/work/a.ts", file_text: "text" },
      { path: "/work/a.ts", file_content: "text" },
    ]) {
      const { call } = report(plain, "Write", input);
      expect(call.title).toBe("Write a.ts");
      expect(call.locations).toEqual([{ path: "/work/a.ts" }]);
      expect(call.content).toEqual([
        { type: "diff", path: "/work/a.ts", oldText: null, newText: "text" },
      ]);
    }
  });

  it("keeps the Edit text only in the diff", () => {
    const input = { file_path: "/work/a.ts", old_string: "a", new_string: "b", replace_all: true };
    const { call, updates } = report(terminal, "Edit", input, {
      content: "The file was updated",
    });
    expect(call.content).toEqual([
      { type: "diff", path: "/work/a.ts", oldText: "a", newText: "b" },
    ]);
    // The confirmation has no display form.
    expect(updates[0].rawOutput).toBe("The file was updated");
  });

  it("keeps the NotebookEdit source in rawInput with one display copy", () => {
    const input = { notebook_path: "/work/a.ipynb", cell_id: "c", new_source: "x = 1" };
    const { call, updates } = report(terminal, "NotebookEdit", input, {
      content: "Updated c with x = 1",
    });
    expect(call.rawInput).toEqual(input);
    expect(call.content).toEqual([]);
    expect(updates[0].content).toEqual([
      { type: "content", content: { type: "text", text: "Updated c with x = 1" } },
    ]);
  });

  it("reports Grep and Glob hits as content", () => {
    const grep = report(terminal, "Grep", { pattern: "todo" }, { content: "a.ts:1" });
    expect(grep.call.title).toBe('grep "todo"');
    expect(grep.updates[0].content).toEqual([
      { type: "content", content: { type: "text", text: "a.ts:1" } },
    ]);
    const glob = report(terminal, "Glob", { pattern: "*.ts" }, { content: "a.ts" });
    expect(glob.call.title).toBe("Find `*.ts`");
    expect(glob.updates[0].content).toEqual([
      { type: "content", content: { type: "text", text: "a.ts" } },
    ]);
  });

  it("shows the WebFetch prompt once", () => {
    const input = { url: "https://e.com", prompt: "Summarize" };
    expect(report(terminal, "WebFetch", input).call.content).toEqual([
      { type: "content", content: { type: "text", text: "Summarize" } },
    ]);
  });

  it("reports WebSearch hits from the structured result", () => {
    const { updates } = report(
      terminal,
      "WebSearch",
      { query: "acp" },
      {
        content: "Web search results: ...",
        structured: { results: [{ content: [{ title: "ACP", url: "https://acp" }] }] },
      },
    );
    expect(updates[0].content).toEqual([
      { type: "content", content: { type: "text", text: "ACP (https://acp)" } },
    ]);
  });

  it("shows an Agent's prompt as content", () => {
    const input = { description: "Explore", prompt: "Inspect the project" };
    const call = report(terminal, "Agent", input).call;
    expect(call).toMatchObject({
      title: "Explore",
      content: [{ type: "content", content: { type: "text", text: "Inspect the project" } }],
      _meta: { claudeCode: { toolName: "Agent" } },
    });
  });

  it("reports TodoWrite as a plan, not as a tool call", () => {
    const { call } = report(terminal, "TodoWrite", {
      todos: [{ content: "Test", status: "pending", activeForm: "Testing" }],
    });
    expect(call).toEqual({
      sessionUpdate: "plan",
      entries: [{ content: "Test", status: "pending", priority: "medium" }],
    });
  });

  describe("agent control tools", () => {
    const text = (value: string) => [{ type: "content", content: { type: "text", text: value } }];

    it("sends the ListAgents result as plain text", () => {
      const list = "This session is ultimate-f5.\n\nSubagents (1): reviewer";
      const { updates } = report(terminal, "ListAgents", {}, { content: list });
      expect(updates[0]).toMatchObject({ status: "completed", content: text(list) });
    });

    it("sends the exact SendMessage and TaskStop JSON", () => {
      for (const name of ["SendMessage", "TaskStop"]) {
        const json = '{"success":true,"message":"Message sent"}';
        const { updates } = report(terminal, name, {}, { content: [{ type: "text", text: json }] });
        expect(updates[0]).toMatchObject({ status: "completed", content: text(json) });
      }
    });

    it("keeps the fenced error result", () => {
      const { updates } = report(plain, "Monitor", {}, { content: "Denied", is_error: true });
      expect(updates[0]).toMatchObject({ status: "failed", content: text("```\nDenied\n```") });
    });
  });

  describe("ExitPlanMode", () => {
    const input = { plan: "1. Do it" };

    it("shows the plan once and sends no approval text", () => {
      const { call, updates } = report(terminal, "ExitPlanMode", input, {
        content: "User has approved your plan.\n\n## Approved Plan:\n1. Do it",
      });
      expect(call.content).toEqual([
        { type: "content", content: { type: "text", text: "1. Do it" } },
      ]);
      expect(updates[0]).toMatchObject({ status: "completed", title: "Exited Plan Mode" });
      expect(updates[0]).not.toHaveProperty("content");
    });

    it("sends the rejection reason once, unfenced, in rawOutput", () => {
      const { updates } = report(terminal, "ExitPlanMode", input, {
        content: "```\nKeep the tests\n```",
        is_error: true,
      });
      expect(updates[0]).toMatchObject({ status: "failed", rawOutput: "Keep the tests" });
    });
  });

  it("names the AskUserQuestion with its question", () => {
    const input = { questions: [{ question: "Which mode?", header: "Mode", options: [] }] };
    const { call } = report(terminal, "AskUserQuestion", input);
    expect(call.title).toBe("Which mode?");
    expect(call.content).toEqual([
      { type: "content", content: { type: "text", text: "Which mode?" } },
    ]);
  });

  it("marks an MCP tool call and shows its text result once", () => {
    const { call, updates } = report(
      terminal,
      "mcp__github__list",
      { repo: "acp" },
      {
        content: [{ type: "text", text: "3 issues" }],
      },
    );
    expect(call._meta).toMatchObject({ claudeCode: { toolName: "mcp__github__list" } });
    expect(updates[0].content).toEqual([
      { type: "content", content: { type: "text", text: "3 issues" } },
    ]);
  });

  it.each(["TaskOutput", "TaskStop"])("reports %s through the generic reporter", (name) => {
    const { call, updates } = report(terminal, name, { task_id: "b1" }, { content: "done" });
    expect(call).toMatchObject({ title: name, kind: "other", content: [] });
    expect(updates[0].content).toEqual([
      { type: "content", content: { type: "text", text: "done" } },
    ]);
  });
});

describe("tool call reports outside the tool_use stream", () => {
  const renderer = AcpToolCallRenderer.for(terminal);

  it("reports a memory recall as a completed read", () => {
    expect(
      renderer.memoryRecall({ uuid: "m", mode: "select", memories: [{ path: "/mem/a.md" }] }),
    ).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: "m",
      title: "Recalled 1 memory",
      kind: "read",
      status: "completed",
      locations: [{ path: "/mem/a.md" }],
      _meta: { claudeCode: { toolName: "memory_recall", toolResponse: { mode: "select" } } },
    });
    expect(
      renderer.memoryRecall({
        uuid: "m",
        mode: "synthesize",
        memories: [{ path: "/mem/a.md", content: "Use pnpm" }],
      }),
    ).toMatchObject({
      title: "Recalled synthesized memory",
      content: [{ type: "content", content: { type: "text", text: "Use pnpm" } }],
    });
  });

  it("sends the denial reason once", () => {
    const denied = renderer.permissionDenied({
      toolCallId: "t",
      toolName: "Bash",
      decisionReasonType: "rule",
      decisionReason: "Denied by rule Bash(rm:*)",
      message: "Denied by rule Bash(rm:*)",
    }) as any;
    expect(denied.content).toEqual([
      {
        type: "content",
        content: { type: "text", text: "Permission denied: Denied by rule Bash(rm:*)" },
      },
    ]);
    expect(denied._meta.claudeCode.toolResponse).toEqual({
      decisionReasonType: "rule",
      decisionReason: "Denied by rule Bash(rm:*)",
      message: "Denied by rule Bash(rm:*)",
    });
  });

  it("sends the in_progress status of progress beats once", () => {
    const tracker = new ToolCallFieldTracker();
    tracker.apply(renderer.toolCall({ id: "t", name: "Agent", input: {} }));
    const beat = (elapsedTimeSeconds: number) => {
      const update = renderer.progress({
        toolCallId: "t",
        toolName: "Agent",
        elapsedTimeSeconds,
        subagentType: "Explore",
      }) as any;
      tracker.apply(update);
      return update;
    };
    expect(beat(1).status).toBe("in_progress");
    const second = beat(2);
    expect(second).not.toHaveProperty("status");
    expect(second._meta.claudeCode.toolResponse).toEqual({
      elapsedTimeSeconds: 2,
      subagentType: "Explore",
    });
  });
});

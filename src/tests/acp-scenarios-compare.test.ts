import { describe, expect, it } from "vitest";
import { compareWithBaseline } from "./acp-scenarios/compare.js";
import type { Recorded } from "./acp-scenarios/harness.js";

function update(fields: Record<string, unknown>): Recorded {
  return { kind: "sessionUpdate", payload: { sessionId: "s", update: fields } };
}

const toolCall = update({
  sessionUpdate: "tool_call",
  toolCallId: "t",
  title: "Read",
  status: "pending",
  _meta: { claudeCode: { toolName: "Read" } },
});

const result = {
  sessionUpdate: "tool_call_update",
  toolCallId: "t",
  title: "Read",
  status: "completed",
  rawOutput: "text",
  _meta: { claudeCode: { toolName: "Read" } },
};

const baseline = [toolCall, update(result)];

/** A copy of `value` without `key`. */
function omit(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

describe("compareWithBaseline", () => {
  it("accepts the baseline itself", () => {
    expect(compareWithBaseline(baseline, baseline)).toEqual([]);
  });

  it("accepts an update without a field that did not change", () => {
    expect(compareWithBaseline(baseline, [toolCall, update(omit(result, "title"))])).toEqual([]);
  });

  it("reports a dropped _meta key", () => {
    expect(compareWithBaseline(baseline, [toolCall, update(omit(result, "_meta"))])).toContainEqual(
      expect.stringMatching(/^origin\/main sent .*"toolName":"Read"/u),
    );
  });

  it("reports a changed rawOutput", () => {
    const changed = update({ ...result, rawOutput: "other" });
    expect(compareWithBaseline(baseline, [toolCall, changed])).toContainEqual(
      expect.stringMatching(/but the adapter sent .*"rawOutput":"other"/u),
    );
  });

  it("reports an extra update", () => {
    const extra = update({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "failed" });
    expect(compareWithBaseline(baseline, [...baseline, extra])).toEqual([
      expect.stringMatching(/^origin\/main did not send /u),
    ]);
  });

  describe("task notification settle", () => {
    const running = update({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      status: "in_progress",
    });
    const held = [toolCall, running];
    const settleFields = {
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "done" } }],
    };
    const settle = update(settleFields);

    it("accepts a card that stays in_progress and is settled later", () => {
      expect(compareWithBaseline(held, [toolCall, running, settle])).toEqual([]);
    });

    it("accepts the settle of a card whose placeholder already completed", () => {
      expect(compareWithBaseline(baseline, [...baseline, settle])).toEqual([]);
    });

    it("reports a settle of a card that origin/main never reported", () => {
      const unknown = update({ ...settleFields, toolCallId: "other" });
      expect(compareWithBaseline(baseline, [...baseline, unknown])).toContainEqual(
        expect.stringMatching(/^origin\/main did not send /u),
      );
    });

    it("reports a settle without the summary of the notification", () => {
      const bare = update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t",
        status: "completed",
      });
      expect(compareWithBaseline(baseline, [...baseline, bare])).toContainEqual(
        expect.stringMatching(/^origin\/main did not send /u),
      );
    });
  });

  describe("terminal_exit unknown code", () => {
    const call = update({
      sessionUpdate: "tool_call",
      toolCallId: "t",
      title: "Bash",
      status: "pending",
      _meta: { claudeCode: { toolName: "Bash" } },
    });
    const exit = (exitCode: number | null) =>
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t",
        status: "completed",
        _meta: { terminal_exit: { exit_code: exitCode } },
      });
    // 同一张卡片、在 exit 报告之前到达的 adapter 专属行。
    const adapterTally = update({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      _meta: { "_universe/tally": 1 },
    });

    it("accepts a null exit code where origin/main sent a code", () => {
      expect(compareWithBaseline([call, exit(1)], [call, exit(null)])).toEqual([]);
    });

    it("accepts the null exit code when an adapter line precedes it", () => {
      expect(compareWithBaseline([call, exit(1)], [call, adapterTally, exit(null)])).toEqual([]);
    });

    it("still reports a different exit code", () => {
      expect(compareWithBaseline([call, exit(1)], [call, exit(0)])).toContainEqual(
        expect.stringMatching(/^origin\/main sent .*but the adapter sent /u),
      );
    });
  });

  describe("AskUserQuestion result", () => {
    const askCall = update({
      sessionUpdate: "tool_call",
      toolCallId: "t",
      title: "Asking for your input",
      status: "pending",
      _meta: { claudeCode: { toolName: "AskUserQuestion" } },
    });
    const questionText = 'User has answered your questions: "Which database?"="Postgres".';
    const rawResult = update({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: questionText } }],
    });
    const renderedResult = update({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "text", text: "> Which database?\n**答案**：Postgres" },
        },
      ],
    });

    it("accepts the readable rewrite of the answers", () => {
      expect(compareWithBaseline([askCall, rawResult], [askCall, renderedResult])).toEqual([]);
    });

    it("still reports a change outside the content", () => {
      const changed = update({ ...renderedResult, rawOutput: "other" });
      expect(compareWithBaseline([askCall, rawResult], [askCall, changed])).toContainEqual(
        expect.stringMatching(/but the adapter sent .*"rawOutput":"other"/u),
      );
    });

    it("reports the rewrite of a tool that is not AskUserQuestion", () => {
      const readCall = update({
        sessionUpdate: "tool_call",
        toolCallId: "t",
        title: "Read",
        status: "pending",
        _meta: { claudeCode: { toolName: "Read" } },
      });
      expect(compareWithBaseline([readCall, rawResult], [readCall, renderedResult])).toContainEqual(
        expect.stringMatching(/^origin\/main sent .*but the adapter sent /u),
      );
    });
  });

  describe("available_commands_update", () => {
    const commands = (...names: string[]) =>
      update({
        sessionUpdate: "available_commands_update",
        availableCommands: names.map((name) => ({ name, description: name })),
      });

    it("accepts the mcp command of the adapter", () => {
      expect(compareWithBaseline([commands("compact")], [commands("compact", "mcp")])).toEqual([]);
      expect(compareWithBaseline([commands()], [commands("mcp")])).toEqual([]);
    });

    it("reports any other extra command", () => {
      expect(compareWithBaseline([commands()], [commands("mcp", "other")])).toContainEqual(
        expect.stringMatching(/but the adapter sent .*"name":"other"/u),
      );
    });

    it("reports a dropped command", () => {
      expect(compareWithBaseline([commands("compact")], [commands("mcp")])).toContainEqual(
        expect.stringMatching(/^origin\/main sent .*"name":"compact"/u),
      );
    });

    it("reports a changed mcp command that origin/main listed", () => {
      const changed = update({
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "mcp", description: "other" }],
      });
      expect(compareWithBaseline([commands("mcp")], [changed])).toContainEqual(
        expect.stringMatching(/but the adapter sent .*"description":"other"/u),
      );
    });
  });
});

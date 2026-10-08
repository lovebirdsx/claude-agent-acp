import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { ContextCompactionMetadata } from "../../context-compaction.js";
import { textContent } from "../content.js";

type CompactionFacts = ContextCompactionMetadata;
type ToolCallUpdate = SessionNotification["update"];

const TITLE = "Compact conversation";

/**
 * The synthetic "Compact conversation" tool call.
 *
 * The client gets the upstream fields: the tool name `compact`, and the facts
 * in `rawOutput`. The error also goes to `content` once, because it is the
 * result to show.
 */
export const compactionToolCall = {
  started(compactionId: string): ToolCallUpdate {
    return {
      sessionUpdate: "tool_call",
      toolCallId: compactionId,
      title: TITLE,
      kind: "think",
      status: "in_progress",
      _meta: { claudeCode: { toolName: "compact" } },
    };
  },

  inProgress(compactionId: string): ToolCallUpdate {
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: compactionId,
      status: "in_progress",
      _meta: { claudeCode: { toolName: "compact" } },
    };
  },

  /** The terminal report. A missed opening makes it the first report, a `tool_call`. */
  finished(
    compactionId: string,
    status: "completed" | "failed" | undefined,
    facts: CompactionFacts,
    first: boolean,
  ): ToolCallUpdate {
    const errorContent =
      status === "failed" && facts.error
        ? { content: [textContent(`Compaction failed: ${facts.error}`)] }
        : {};
    const rawOutput = Object.keys(facts).length > 0 ? { rawOutput: facts } : {};
    if (first) {
      return {
        sessionUpdate: "tool_call",
        toolCallId: compactionId,
        title: TITLE,
        kind: "think",
        status: status ?? "completed",
        ...errorContent,
        ...rawOutput,
        _meta: { claudeCode: { toolName: "compact" } },
      };
    }
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: compactionId,
      ...(status ? { status } : {}),
      ...errorContent,
      ...rawOutput,
      _meta: { claudeCode: { toolName: "compact" } },
    };
  },
};

import type { ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import type { ClientCapabilities } from "./client-capabilities.js";

/** A tool use as the SDK reports it. */
export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

/**
 * The facts of a tool use, read once from its input. The
 * {@link AcpToolCallRenderer} decides which ACP field carries each fact.
 */
export interface ToolUseFacts {
  /** A short label. Not the input and not the output. */
  title: string;
  kind: ToolKind;
  locations?: ToolCallLocation[];
  /** The file change that the input makes, as diff content. */
  change?: ToolCallContent[];
  /**
   * A display copy of the input that the user reads: a plan, a subagent
   * prompt, a question, a command description.
   */
  display?: ToolCallContent[];
  /** The tool runs a command. Its output goes to the terminal channel. */
  command?: boolean;
}

/** The output of a command, for the terminal channel. */
export interface CommandOutput {
  output: string;
  /** 命令的退出码，仅当 tool result 明确给出时才有值；不给时缺省（失败但未点名
   *  退出码、被中断或转后台的命令、被 Claude Code 判为成功的非零码）。 */
  exitCode?: number;
  /** 命令在结束前被中断。 */
  interrupted?: boolean;
}

/**
 * The facts of a tool result, read once from the SDK tool_result.
 *
 * `rawOutput` is present when the reporter decided what the raw output is.
 * Otherwise the renderer sends the raw tool_result as `rawOutput` only when
 * nothing else carries the result.
 */
export interface ToolResultFacts {
  title?: string;
  /** The result to show. */
  content?: ToolCallContent[];
  /** The final locations of an edit. */
  locations?: ToolCallLocation[];
  /** The output of a command. */
  command?: CommandOutput;
  /** A result that has no display form. */
  rawOutput?: unknown;
}

/** What a reporter reads besides the input of the tool use. */
export interface ToolUseContext {
  cwd?: string;
  capabilities: ClientCapabilities;
  /**
   * True when the tool use comes from the history of a loaded session. The
   * files on disk then show a later state, so a reporter must not read them.
   */
  replay?: boolean;
}

/** What a reporter reads to report a tool result. */
export interface ToolResultContext {
  toolUse: ToolUse;
  /** The SDK tool_result block. */
  result: { content?: unknown; is_error?: boolean | null; tool_use_id?: string };
  /** The structured `tool_use_result` of the SDK message, when it is known. */
  structured?: unknown;
  capabilities: ClientCapabilities;
}

/**
 * Turns the SDK data of one tool kind into tool facts. A reporter holds no
 * state and knows nothing about the ACP fields.
 */
export interface ToolReporter {
  toolUse(input: unknown, context: ToolUseContext): ToolUseFacts;
  /**
   * The facts of a successful result. Without this method, the result text
   * that the model saw is the result to show.
   */
  toolResult?(context: ToolResultContext): ToolResultFacts;
  /**
   * The facts of an error result. Without this method, the error text is the
   * result to show.
   */
  errorResult?(context: ToolResultContext): ToolResultFacts | undefined;
  /**
   * The facts of the PostToolUse hook `tool_response`: the final file change
   * of an edit tool.
   */
  hookResult?(toolResponse: unknown, context: ToolUseContext): Promise<ToolResultFacts>;
}

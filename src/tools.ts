import {
  ContentBlock,
  PlanEntry,
  SessionNotification,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import {
  AgentInput,
  AgentOutput,
  AskUserQuestionInput,
  BashInput,
  BashOutput,
  FileEditInput,
  FileReadInput,
  FileReadOutput,
  FileWriteInput,
  GlobInput,
  GrepInput,
  ReportFindingsInput,
  TaskCreateInput,
  TaskCreateOutput,
  TaskUpdateInput,
  TodoWriteInput,
  WebFetchInput,
  WebSearchInput,
  WebSearchOutput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import {
  ImageBlockParam,
  TextBlockParam,
  ToolResultBlockParam,
  WebSearchResultBlock,
  WebSearchToolResultBlockParam,
  WebSearchToolResultError,
} from "@anthropic-ai/sdk/resources";
import {
  BetaBashCodeExecutionResultBlock,
  BetaBashCodeExecutionToolResultBlockParam,
  BetaBashCodeExecutionToolResultError,
  BetaCodeExecutionResultBlock,
  BetaCodeExecutionToolResultBlockParam,
  BetaCodeExecutionToolResultError,
  BetaImageBlockParam,
  BetaRequestMCPToolResultBlockParam,
  BetaTextEditorCodeExecutionCreateResultBlock,
  BetaTextEditorCodeExecutionStrReplaceResultBlock,
  BetaTextEditorCodeExecutionToolResultBlockParam,
  BetaTextEditorCodeExecutionToolResultError,
  BetaTextEditorCodeExecutionViewResultBlock,
  BetaToolReferenceBlock,
  BetaToolResultBlockParam,
  BetaToolSearchToolResultBlockParam,
  BetaToolSearchToolResultError,
  BetaToolSearchToolSearchResultBlock,
  BetaWebFetchBlock,
  BetaWebFetchToolResultBlockParam,
  BetaWebFetchToolResultErrorBlock,
  BetaWebSearchToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta.mjs";
import fs from "node:fs";
import path from "node:path";
import { Logger, type ToolUpdateMeta } from "./acp-agent.js";

/**
 * Union of all possible content types that can appear in tool results from the Anthropic SDK.
 * These are transformed to valid ACP ContentBlock types by toValidAcpContent().
 */
type ToolResultContent =
  | TextBlockParam
  | ImageBlockParam
  | BetaImageBlockParam
  | BetaToolReferenceBlock
  | BetaToolSearchToolSearchResultBlock
  | BetaToolSearchToolResultError
  | WebSearchResultBlock
  | WebSearchToolResultError
  | BetaWebFetchBlock
  | BetaWebFetchToolResultErrorBlock
  | BetaCodeExecutionResultBlock
  | BetaCodeExecutionToolResultError
  | BetaBashCodeExecutionResultBlock
  | BetaBashCodeExecutionToolResultError
  | BetaTextEditorCodeExecutionViewResultBlock
  | BetaTextEditorCodeExecutionCreateResultBlock
  | BetaTextEditorCodeExecutionStrReplaceResultBlock
  | BetaTextEditorCodeExecutionToolResultError;

interface ToolInfo {
  title: string;
  kind: ToolKind;
  content: ToolCallContent[];
  locations?: ToolCallLocation[];
}

interface ToolUpdate {
  title?: string;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  _meta?: {
    terminal_info?: {
      terminal_id: string;
    };
    terminal_output?: {
      terminal_id: string;
      data: string;
    };
    terminal_exit?: {
      terminal_id: string;
      exit_code: number;
      signal: string | null;
    };
  };
}

/**
 * Convert an absolute file path to a project-relative path for display.
 * Returns the original path if it's outside the project directory or if no cwd is provided.
 */
export function toDisplayPath(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;
  const resolvedCwd = path.resolve(cwd);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile.startsWith(resolvedCwd + path.sep) || resolvedFile === resolvedCwd) {
    return path.relative(resolvedCwd, resolvedFile);
  }
  return filePath;
}

export function toolInfoFromToolUse(
  toolUse: any,
  supportsTerminalOutput: boolean = false,
  cwd?: string,
): ToolInfo {
  const name = toolUse.name;

  switch (name) {
    case "Agent":
    case "Task": {
      const input = toolUse.input as AgentInput | BashInput | undefined;
      return {
        title: input?.description ? input.description : "Task",
        kind: "think",
        content:
          input && "prompt" in input
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.prompt },
                },
              ]
            : [],
      };
    }

    case "Bash": {
      const input = toolUse.input as BashInput | undefined;
      return {
        title: input?.command ? input.command : "Terminal",
        kind: "execute",
        content: supportsTerminalOutput
          ? [{ type: "terminal" as const, terminalId: toolUse.id }]
          : input && input.description
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.description },
                },
              ]
            : [],
      };
    }

    case "Read": {
      const input = toolUse.input as FileReadInput | undefined;
      let limit = "";
      if (input?.limit && input.limit > 0) {
        limit = " (" + (input.offset ?? 1) + " - " + ((input.offset ?? 1) + input.limit - 1) + ")";
      } else if (input?.offset) {
        limit = " (from line " + input.offset + ")";
      }
      const displayPath = input?.file_path ? toDisplayPath(input.file_path, cwd) : "File";
      return {
        title: "Read " + displayPath + limit,
        kind: "read",
        locations: input?.file_path
          ? [
              {
                path: input.file_path,
                line: input.offset ?? 1,
              },
            ]
          : [],
        content: [],
      };
    }

    case "Write": {
      const input = toolUse.input as FileWriteInput | undefined;
      let content: ToolCallContent[] = [];
      if (input && input.file_path) {
        content = [
          {
            type: "diff",
            path: input.file_path,
            oldText: null,
            newText: input.content,
          },
        ];
      } else if (input && input.content) {
        content = [
          {
            type: "content",
            content: { type: "text", text: input.content },
          },
        ];
      }
      const displayPath = input?.file_path ? toDisplayPath(input.file_path, cwd) : undefined;
      return {
        title: displayPath ? `Write ${displayPath}` : "Write",
        kind: "edit",
        content,
        locations: input?.file_path ? [{ path: input.file_path }] : [],
      };
    }

    case "Edit": {
      const input = toolUse.input as FileEditInput | undefined;
      let content: ToolCallContent[] = [];
      if (input && input.file_path && (input.old_string || input.new_string)) {
        content = [
          {
            type: "diff",
            path: input.file_path,
            oldText: input.old_string || null,
            newText: input.new_string ?? "",
          },
        ];
      }
      const displayPath = input?.file_path ? toDisplayPath(input.file_path, cwd) : undefined;
      return {
        title: displayPath ? `Edit ${displayPath}` : "Edit",
        kind: "edit",
        content,
        locations: input?.file_path ? [{ path: input.file_path }] : [],
      };
    }

    case "Glob": {
      const input = toolUse.input as GlobInput | undefined;
      let label = "Find";
      if (input?.path) {
        label += ` \`${input.path}\``;
      }
      if (input?.pattern) {
        label += ` \`${input.pattern}\``;
      }
      return {
        title: label,
        kind: "search",
        content: [],
        locations: input?.path ? [{ path: input.path }] : [],
      };
    }

    case "Grep": {
      const input = toolUse.input as GrepInput | undefined;
      let label = "grep";

      if (input?.["-i"]) {
        label += " -i";
      }
      if (input?.["-n"]) {
        label += " -n";
      }

      if (input?.["-A"] !== undefined) {
        label += ` -A ${input["-A"]}`;
      }
      if (input?.["-B"] !== undefined) {
        label += ` -B ${input["-B"]}`;
      }
      if (input?.["-C"] !== undefined) {
        label += ` -C ${input["-C"]}`;
      }

      if (input?.output_mode) {
        switch (input.output_mode) {
          case "files_with_matches":
            label += " -l";
            break;
          case "count":
            label += " -c";
            break;
          case "content":
          default:
            break;
        }
      }

      if (input?.head_limit !== undefined) {
        label += ` | head -${input.head_limit}`;
      }

      if (input?.glob) {
        label += ` --include="${input.glob}"`;
      }

      if (input?.type) {
        label += ` --type=${input.type}`;
      }

      if (input?.multiline) {
        label += " -P";
      }

      if (input?.pattern) {
        label += ` "${input.pattern}"`;
      }

      if (input?.path) {
        label += ` ${input.path}`;
      }

      return {
        title: label,
        kind: "search",
        content: [],
      };
    }

    case "WebFetch": {
      const input = toolUse.input as WebFetchInput;
      return {
        title: input?.url ? `Fetch ${input.url}` : "Fetch",
        kind: "fetch",
        content:
          input && input.prompt
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.prompt },
                },
              ]
            : [],
      };
    }

    case "WebSearch": {
      const input = toolUse.input as WebSearchInput | undefined;
      let label = input?.query ? `"${input.query}"` : "Web search";

      if (input?.allowed_domains && input.allowed_domains.length > 0) {
        label += ` (allowed: ${input.allowed_domains.join(", ")})`;
      }

      if (input?.blocked_domains && input.blocked_domains.length > 0) {
        label += ` (blocked: ${input.blocked_domains.join(", ")})`;
      }

      return {
        title: label,
        kind: "fetch",
        content: [],
      };
    }

    case "TodoWrite": {
      const input = toolUse.input as TodoWriteInput | undefined;
      return {
        title: Array.isArray(input?.todos)
          ? `Update TODOs: ${input.todos.map((todo: any) => todo.content).join(", ")}`
          : "Update TODOs",
        kind: "think",
        content: [],
      };
    }

    case "ReportFindings": {
      const input = toolUse.input as ReportFindingsInput | undefined;
      const findings = input?.findings ?? [];
      return {
        title:
          findings.length === 0
            ? "Report findings: none found"
            : `Report ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
        kind: "think",
        content: findings.map((finding) => ({
          type: "content" as const,
          content: {
            type: "text" as const,
            text: `**${finding.file}${finding.line ? `:${finding.line}` : ""}** — ${finding.summary}`,
          },
        })),
      };
    }

    case "TaskCreate": {
      const input = toolUse.input as TaskCreateInput | undefined;
      return {
        title: input?.subject ? `Create task: ${input.subject}` : "Create task",
        kind: "think",
        content: [],
      };
    }

    case "TaskUpdate": {
      const input = toolUse.input as TaskUpdateInput | undefined;
      return {
        title: input?.subject ? `Update task: ${input.subject}` : "Update task",
        kind: "think",
        content: [],
      };
    }

    case "TaskList": {
      return {
        title: "List tasks",
        kind: "think",
        content: [],
      };
    }

    case "TaskGet": {
      return {
        title: "Get task",
        kind: "think",
        content: [],
      };
    }

    case "ExitPlanMode": {
      const planInput = toolUse.input as { plan?: string } | undefined;
      return {
        title: "Ready to code?",
        kind: "switch_mode",
        content: planInput?.plan
          ? [{ type: "content" as const, content: { type: "text" as const, text: planInput.plan } }]
          : [],
      };
    }

    case "AskUserQuestion": {
      const input = toolUse.input as Partial<AskUserQuestionInput> | undefined;
      const questions = Array.isArray(input?.questions) ? input.questions : [];
      return {
        title:
          questions.length === 1 && questions[0]?.question
            ? questions[0].question
            : "Asking for your input",
        kind: "other",
        content: questions
          .filter((q) => typeof q?.question === "string")
          .map((q) => ({
            type: "content" as const,
            content: { type: "text" as const, text: q.question },
          })),
      };
    }

    case "Other": {
      const input = toolUse.input;
      let output;
      try {
        output = JSON.stringify(input, null, 2);
      } catch {
        output = typeof input === "string" ? input : "{}";
      }
      return {
        title: name || "Unknown Tool",
        kind: "other",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `\`\`\`json\n${output}\`\`\``,
            },
          },
        ],
      };
    }

    default:
      return {
        title: name || "Unknown Tool",
        kind: "other",
        content: [],
      };
  }
}

/**
 * Narrow the untyped message-level `tool_use_result` toward a per-tool Output
 * shape: rejects everything but a plain non-null object (arrays pass a bare
 * `typeof === "object"` check, so they're excluded here). The returned value
 * is only *nominally* typed — it arrives over the wire from arbitrary CLI
 * versions, so each caller must still guard the specific fields it reads
 * before trusting them.
 */
function structuredResult<T extends object>(toolUseResult: unknown): T | undefined {
  return toolUseResult !== null &&
    typeof toolUseResult === "object" &&
    !Array.isArray(toolUseResult)
    ? (toolUseResult as T)
    : undefined;
}

/**
 * Strip the model-directed trailer from a raw Agent/Task tool_result text:
 * a `<usage>…</usage>` totals block and/or an
 * `agentId: <id> (use SendMessage …)` continuation line at the end of the
 * text. Both patterns are tail-anchored and independent (older CLIs emit
 * variants with only one of them), so a format change makes them stop
 * matching rather than mangle the report.
 */
function stripAgentTrailer(text: string): string {
  return stripAgentIdLine(stripUsageBlock(text));
}

const USAGE_OPEN = "<usage>";
const USAGE_CLOSE = "</usage>";

/** Remove a trailing `<usage>…</usage>` block, plus trailing whitespace and
 *  one preceding newline. Matches from the *last* `<usage>` so a report that
 *  merely mentions the marker earlier isn't truncated at the mention. */
function stripUsageBlock(text: string): string {
  const body = text.trimEnd();
  if (!body.endsWith(USAGE_CLOSE)) {
    return text;
  }
  const open = body.lastIndexOf(USAGE_OPEN, body.length - USAGE_CLOSE.length - USAGE_OPEN.length);
  if (open === -1) {
    return text;
  }
  return body.slice(0, open > 0 && body[open - 1] === "\n" ? open - 1 : open);
}

/** The continuation line, anchored to a whole line so the regex has a single
 *  start position and no ambiguous repetition (`[\w-]+` can't consume the
 *  following space, `[^)]*` can't consume the closing paren) — it runs in
 *  linear time on any input. */
const AGENT_ID_LINE = /^agentId: [\w-]+ \([^)]*\)$/;

/** Remove a final `agentId: <id> (…)` line, plus trailing whitespace and the
 *  newline that preceded the line. */
function stripAgentIdLine(text: string): string {
  const body = text.trimEnd();
  const lineStart = body.lastIndexOf("\n") + 1;
  if (!AGENT_ID_LINE.test(body.slice(lineStart))) {
    return text;
  }
  return body.slice(0, Math.max(lineStart - 1, 0));
}

/** Apply {@link stripAgentTrailer} across a raw tool_result `content` (plain
 *  string or block array), leaving non-text blocks untouched. */
function stripAgentTrailerFromContent(content: unknown): unknown {
  if (typeof content === "string") {
    return stripAgentTrailer(content);
  }
  if (Array.isArray(content)) {
    return content.map((block) =>
      block !== null &&
      typeof block === "object" &&
      block.type === "text" &&
      typeof block.text === "string"
        ? { ...block, text: stripAgentTrailer(block.text) }
        : block,
    );
  }
  return content;
}

/**
 * 编辑器点击 "No, keep planning"（未填意见）时 fork 回传的默认 deny message。与之
 * 相等的 tool_result 内容是纯内部文案，不向用户展示。见 acp-agent.ts 的 ExitPlanMode
 * 分支；renderer 端也据此判定（toolCallDisplay.ts 的 DEFAULT_KEEP_PLANNING_MESSAGE）。
 */
export const DEFAULT_EXIT_PLAN_DENY_MESSAGE = "User rejected request to exit plan mode.";

/** 从 ExitPlanMode 的 deny tool_result 内容里抽出纯文本（content 可能是 string 或数组）。 */
function exitPlanModeDenyText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (c && typeof c === "object" && c.type === "text" ? String(c.text) : ""))
      .join("")
      .trim();
  }
  return "";
}

export function toolUpdateFromToolResult(
  toolResult:
    | ToolResultBlockParam
    | BetaToolResultBlockParam
    | BetaWebSearchToolResultBlockParam
    | BetaWebFetchToolResultBlockParam
    | WebSearchToolResultBlockParam
    | BetaCodeExecutionToolResultBlockParam
    | BetaBashCodeExecutionToolResultBlockParam
    | BetaTextEditorCodeExecutionToolResultBlockParam
    | BetaRequestMCPToolResultBlockParam
    | BetaToolSearchToolResultBlockParam,
  toolUse: any | undefined,
  supportsTerminalOutput: boolean = false,
  toolUseResult?: unknown,
): ToolUpdate {
  // ExitPlanMode 的"拒绝"不是真正的错误，而是用户选择「继续规划」。默认拒绝文案
  // （"User rejected request to exit plan mode."）是给模型看的内部提示，对用户无意义，
  // 不产生任何可见 content；若用户在编辑器 steering 输入框写下了意见，则作为纯文本
  // （不加错误围栏）透出，成为回放时该意见的唯一可见来源。
  if (toolUse?.name === "ExitPlanMode" && "is_error" in toolResult && toolResult.is_error) {
    const text = exitPlanModeDenyText(toolResult.content);
    if (text && text !== DEFAULT_EXIT_PLAN_DENY_MESSAGE) {
      return { content: [{ type: "content", content: { type: "text", text } }] };
    }
    return {};
  }
  if (
    "is_error" in toolResult &&
    toolResult.is_error &&
    toolResult.content &&
    toolResult.content.length > 0 &&
    !(toolUse?.name === "Bash" && supportsTerminalOutput)
  ) {
    // Only return errors
    return toAcpContentUpdate(toolResult.content, true);
  }

  // Shared raw-text fallback: renders the tool_result content the model saw.
  // The structured cases below fall back to this when `tool_use_result` is
  // absent or fails its shape guard (older CLIs, replayed sessions).
  const rawContentUpdate = () =>
    toAcpContentUpdate(toolResult.content, "is_error" in toolResult ? toolResult.is_error : false);

  switch (toolUse?.name) {
    case "Read": {
      // The raw tool_result text is the model-facing view: line-numbered
      // content plus any appended <system-reminder> blocks (malicious-code
      // checks, memory staleness notes, …) that clients shouldn't see. The
      // structured FileReadOutput carries the clean content — rebuild the
      // line-numbered view from it. Non-text variants (image/notebook/pdf)
      // fall back to the raw content blocks, which already render fine.
      const structuredRead = structuredResult<FileReadOutput>(toolUseResult);
      if (
        structuredRead?.type === "text" &&
        typeof structuredRead.file?.content === "string" &&
        // An empty file has nothing to line-number; keep the raw view (the
        // model-facing "file is empty" note) rather than a phantom blank line.
        structuredRead.file.content.length > 0
      ) {
        // startLine is typed non-optional but defended anyway; a Read's
        // `offset` input is the same 1-based starting line, so it beats a
        // blind 1 when an emitter omits the field.
        const startLine =
          structuredRead.file.startLine ??
          (toolUse.input as FileReadInput | undefined)?.offset ??
          1;
        // A trailing newline is a line terminator, not an extra line — don't
        // number a phantom empty line after it.
        let numbered = structuredRead.file.content
          .replace(/\n$/, "")
          .split("\n")
          .map((line, i) => `${startLine + i}\t${line}`)
          .join("\n");
        // The model-facing truncation banner doesn't survive reconstruction
        // from file.content (the SDK flag exists for exactly this case) —
        // re-establish it so a partial first page doesn't read as the whole
        // file.
        if (structuredRead.file.truncatedByTokenCap) {
          const { numLines, totalLines } = structuredRead.file;
          const detail =
            typeof numLines === "number" && typeof totalLines === "number"
              ? `: showing ${numLines} of ${totalLines} lines`
              : "";
          numbered += `\n[File truncated${detail}]`;
        }
        return {
          content: [
            {
              type: "content",
              content: { type: "text", text: markdownEscape(numbered) },
            },
          ],
        };
      }
      if (Array.isArray(toolResult.content) && toolResult.content.length > 0) {
        return {
          content: toolResult.content.map((content: any) => ({
            type: "content",
            content:
              content.type === "text"
                ? {
                    type: "text",
                    text: markdownEscape(content.text),
                  }
                : toAcpContentBlock(content, false),
          })),
        };
      } else if (typeof toolResult.content === "string" && toolResult.content.length > 0) {
        return {
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: markdownEscape(toolResult.content),
              },
            },
          ],
        };
      }
      return {};
    }

    case "Bash": {
      const result = toolResult.content;
      // The terminal was announced under the tool_use's own id (see
      // `toolInfoFromToolUse`), so key the output/exit metas off that: it is the
      // id the client actually created a terminal for. `toolResult.tool_use_id`
      // is the same value whenever present — the caller looks the tool_use up by
      // it — so preferring `toolUse.id` only adds a source for the case where the
      // result block carries no id at all. Anything that isn't a non-empty
      // string is no id at all: `""` matches no terminal, and stringifying a
      // present-but-undefined field would invent the literal `"undefined"`.
      const terminalIdOf = (id: unknown): string | undefined =>
        typeof id === "string" && id.length > 0 ? id : undefined;
      const terminalId: string | undefined =
        terminalIdOf(toolUse?.id) ??
        terminalIdOf("tool_use_id" in toolResult ? toolResult.tool_use_id : undefined);
      const isError = "is_error" in toolResult && toolResult.is_error;

      // Extract output and exit code from either format:
      // 1. The structured BashOutput (message-level tool_use_result): its
      //    stdout/stderr exclude the model-directed suffixes the raw text
      //    carries (stale-read hints, gh rate-limit hints, the
      //    persisted-output wrapper for too-large outputs — the interruption
      //    and truncation facts those carried are re-established from the
      //    structured flags below). Skipped for image output (the raw content
      //    array carries the actual image blocks) and backgrounded commands
      //    (the raw text carries the background-task notice; structured
      //    stdout may be empty).
      // 2. BetaBashCodeExecutionResultBlock: { type: "bash_code_execution_result", stdout, stderr, return_code }
      // 3. Plain string content from a regular tool_result
      // 4. Array content (e.g. [{ type: "text", text: "..." }] for stdout,
      //    or [{ type: "image", source: {...} }] when the local Bash tool
      //    produces an image, e.g. piping a base64 data URI)
      let output = "";
      let exitCode = isError ? 1 : 0;

      const structuredBash = structuredResult<BashOutput>(toolUseResult);
      if (
        structuredBash &&
        typeof structuredBash.stdout === "string" &&
        typeof structuredBash.stderr === "string" &&
        !structuredBash.isImage &&
        structuredBash.backgroundTaskId === undefined
      ) {
        output = [structuredBash.stdout, structuredBash.stderr].filter(Boolean).join("\n");
        // Two raw-text notices don't survive the structured stdout/stderr —
        // re-establish them so the client isn't shown a clean-looking result:
        // the CLI appends its abort marker only to the model-facing text, and
        // an aborted command isn't a success, so synthesize a failing exit
        // code when the result wasn't already an error.
        if (structuredBash.interrupted) {
          output = [output, "[Command was aborted before completion]"].filter(Boolean).join("\n");
          exitCode = 1;
        }
        // Structured stdout is clipped (~30k chars) when the full output was
        // persisted to disk; without this note the clip is silent and the
        // path to the full output is lost.
        if (typeof structuredBash.persistedOutputPath === "string") {
          const size =
            typeof structuredBash.persistedOutputSize === "number"
              ? ` (${structuredBash.persistedOutputSize} bytes total)`
              : "";
          output = [
            output,
            `[Output truncated${size}: full output saved to ${structuredBash.persistedOutputPath}]`,
          ]
            .filter(Boolean)
            .join("\n");
        }
      } else if (
        result &&
        typeof result === "object" &&
        "type" in result &&
        result.type === "bash_code_execution_result"
      ) {
        const bashResult = result as BetaBashCodeExecutionResultBlock;
        output = [bashResult.stdout, bashResult.stderr].filter(Boolean).join("\n");
        exitCode = bashResult.return_code;
      } else if (typeof result === "string") {
        output = result;
      } else if (Array.isArray(result) && result.length > 0) {
        const textOnly = result.every(
          (c: any) => c && typeof c === "object" && typeof c.text === "string",
        );
        if (textOnly) {
          output = result.map((c: any) => c.text).join("\n");
        } else {
          // Image (or mixed non-text) content. Binary payloads can't be
          // streamed through the terminal-output _meta channel, so bypass
          // it and surface the blocks as ACP content. This handles the
          // local Bash tool's image output, which previously failed the
          // text-only guard and was silently dropped.
          return toAcpContentUpdate(result, isError);
        }
      }

      // Without a terminal id there is nothing the client can reconcile these
      // metas against, and emitting them anyway strands the output: a client that
      // buffers output/exit for terminals it has not been told about (Zed keeps
      // them in `pending_terminal_output`/`pending_terminal_exit`, drained only on
      // a matching create) would hold them forever behind an id that never
      // arrives, showing an empty terminal. Fall through to the code-block
      // rendering below instead.
      if (supportsTerminalOutput && terminalId !== undefined) {
        return {
          content: [{ type: "terminal" as const, terminalId }],
          _meta: {
            terminal_info: {
              terminal_id: terminalId,
            },
            terminal_output: {
              terminal_id: terminalId,
              data: output,
            },
            terminal_exit: {
              terminal_id: terminalId,
              exit_code: exitCode,
              signal: null,
            },
          },
        };
      }
      // Fallback: format output as a code block without terminal _meta
      if (output.trim()) {
        return {
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: `\`\`\`console\n${output.trimEnd()}\n\`\`\``,
              },
            },
          ],
        };
      }
      return {};
    }

    case "Agent":
    case "Task": {
      // The raw tool_result text ends with a model-directed trailer (an
      // `agentId: … (use SendMessage …)` line plus a `<usage>` totals block)
      // that ACP clients shouldn't see. The message-level `tool_use_result`
      // carries the structured AgentOutput whose `content` is the subagent's
      // report without the trailer — render from it when present (per the SDK
      // 0.3.207 guidance) and fall back to the raw text otherwise (older CLIs,
      // replayed sessions).
      // Narrowed to the full union, not the completed variant — the status
      // check below is what discriminates it, and pre-narrowing would let
      // future field reads typecheck against a variant the runtime value may
      // not be.
      const structured = structuredResult<AgentOutput>(toolUseResult);
      if (
        structured?.status === "completed" &&
        Array.isArray(structured.content) &&
        // A completed subagent can end with zero text blocks; an empty
        // structured render would beat the raw fallback for no benefit.
        structured.content.length > 0
      ) {
        return toAcpContentUpdate(
          structured.content,
          "is_error" in toolResult ? toolResult.is_error : false,
        );
      }
      // No structured report to render from (replayed sessions —
      // getSessionMessages doesn't expose the transcript's toolUseResult —
      // and older CLIs). The SDK advises rendering from tool_use_result
      // instead of parsing the text, but with no structured value the
      // tail-anchored strip is the only cleanup available; if the trailer
      // format changes it simply stops matching and the full raw text
      // renders, no worse than before.
      return toAcpContentUpdate(
        stripAgentTrailerFromContent(toolResult.content),
        "is_error" in toolResult ? toolResult.is_error : false,
      );
    }

    case "Edit": // Edit is handled in hooks
    case "Write": {
      return {};
    }

    case "ExitPlanMode": {
      return { title: "Exited Plan Mode" };
    }

    case "WebSearch": {
      // The raw tool_result text is a model-directed dump ("Web search
      // results for query: …\n\nLinks: [{…json…}]"). The structured
      // WebSearchOutput carries the hits — render them the way server-side
      // web_search_result blocks render ("Title (url)").
      const structuredSearch = structuredResult<WebSearchOutput>(toolUseResult);
      if (structuredSearch && Array.isArray(structuredSearch.results)) {
        const lines = structuredSearch.results.flatMap((entry) =>
          typeof entry === "string"
            ? [entry]
            : Array.isArray(entry?.content)
              ? // tool_use_result arrives untyped across CLI version skew —
                // skip off-spec hits rather than rendering
                // "undefined (undefined)" lines.
                entry.content.flatMap((hit) =>
                  typeof hit?.title === "string" && typeof hit?.url === "string"
                    ? [formatWebSearchHit(hit)]
                    : [],
                )
              : [],
        );
        if (lines.length > 0) {
          return {
            content: [
              {
                type: "content",
                content: { type: "text", text: lines.join("\n") },
              },
            ],
          };
        }
      }
      return rawContentUpdate();
    }

    default: {
      return rawContentUpdate();
    }
  }
}

/** One display format for a web-search hit, shared by the structured
 *  WebSearchOutput render and the server-side `web_search_result` block so
 *  the two paths can't drift. */
function formatWebSearchHit(hit: { title: string; url: string }): string {
  return `${hit.title} (${hit.url})`;
}

function toAcpContentUpdate(
  content: any,
  isError: boolean = false,
): { content?: ToolCallContent[] } {
  if (Array.isArray(content) && content.length > 0) {
    return {
      content: content.map((c: any) => ({
        type: "content" as const,
        content: toAcpContentBlock(c, isError),
      })),
    };
  } else if (typeof content === "object" && content !== null && "type" in content) {
    return {
      content: [
        {
          type: "content" as const,
          content: toAcpContentBlock(content, isError),
        },
      ],
    };
  } else if (typeof content === "string" && content.length > 0) {
    return {
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: isError ? `\`\`\`\n${content}\n\`\`\`` : content,
          },
        },
      ],
    };
  }
  return {};
}

function toAcpContentBlock(content: ToolResultContent, isError: boolean): ContentBlock {
  const wrapText = (text: string): ContentBlock => ({
    type: "text" as const,
    text: isError ? `\`\`\`\n${text}\n\`\`\`` : text,
  });

  switch (content.type) {
    case "text":
      return {
        type: "text" as const,
        text: isError ? `\`\`\`\n${content.text}\n\`\`\`` : content.text,
      };
    case "image":
      if (content.source.type === "base64") {
        return {
          type: "image" as const,
          data: content.source.data,
          mimeType: content.source.media_type,
        };
      }
      // URL and file-based images can't be converted to ACP format (requires data)
      return wrapText(
        content.source.type === "url"
          ? `[image: ${content.source.url}]`
          : "[image: file reference]",
      );

    case "tool_reference":
      return wrapText(`Tool: ${content.tool_name}`);
    case "tool_search_tool_search_result":
      return wrapText(
        `Tools found: ${content.tool_references.map((r) => r.tool_name).join(", ") || "none"}`,
      );
    case "tool_search_tool_result_error":
      return wrapText(
        `Error: ${content.error_code}${content.error_message ? ` - ${content.error_message}` : ""}`,
      );
    case "web_search_result":
      return wrapText(formatWebSearchHit(content));
    case "web_search_tool_result_error":
      return wrapText(`Error: ${content.error_code}`);
    case "web_fetch_result":
      return wrapText(`Fetched: ${content.url}`);
    case "web_fetch_tool_result_error":
      return wrapText(`Error: ${content.error_code}`);
    case "code_execution_result":
      return wrapText(`Output: ${content.stdout || content.stderr || ""}`);
    case "bash_code_execution_result":
      return wrapText(`Output: ${content.stdout || content.stderr || ""}`);
    case "code_execution_tool_result_error":
    case "bash_code_execution_tool_result_error":
      return wrapText(`Error: ${content.error_code}`);
    case "text_editor_code_execution_view_result":
      return wrapText(content.content);
    case "text_editor_code_execution_create_result":
      return wrapText(content.is_file_update ? "File updated" : "File created");
    case "text_editor_code_execution_str_replace_result":
      return wrapText(content.lines?.join("\n") || "");
    case "text_editor_code_execution_tool_result_error":
      return wrapText(
        `Error: ${content.error_code}${content.error_message ? ` - ${content.error_message}` : ""}`,
      );

    default:
      return wrapText(JSON.stringify(content));
  }
}

export type ClaudePlanEntry = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
};

export function planEntries(input: { todos: ClaudePlanEntry[] } | undefined): PlanEntry[] {
  return (input?.todos ?? []).map((todo) => ({
    content: todo.content,
    status: todo.status,
    priority: "medium",
  }));
}

/**
 * Per-session task list accumulated from Task* tool calls (TaskCreate /
 * TaskUpdate). The headless/SDK session emits these as incremental tool
 * calls keyed by task ID, replacing the snapshot-style TodoWrite tool.
 * Iteration order is insertion order (Map semantics), matching the order
 * tasks are created.
 */
export type TaskEntry = {
  subject: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
  description?: string;
};
export type TaskState = Map<string, TaskEntry>;

/**
 * Best-effort parse of a TaskCreate tool_result content into the structured
 * TaskCreateOutput. The SDK delivers tool outputs either as a string or as
 * an array of TextBlockParam-like blocks containing JSON text; try both.
 */
export function parseTaskCreateOutput(content: unknown): TaskCreateOutput | undefined {
  const tryParse = (text: string): TaskCreateOutput | undefined => {
    try {
      const parsed = JSON.parse(text);
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.task &&
        typeof parsed.task.id === "string"
      ) {
        return parsed as TaskCreateOutput;
      }
    } catch {
      // ignore
    }
    return undefined;
  };

  if (typeof content === "string") {
    return tryParse(content);
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block && block.type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") {
          const parsed = tryParse(text);
          if (parsed) return parsed;
        }
      }
    }
  }
  return undefined;
}

export function applyTaskCreate(
  state: TaskState,
  input: TaskCreateInput | undefined,
  output: TaskCreateOutput | undefined,
): void {
  const taskId = output?.task?.id;
  if (!taskId || !input) return;
  state.set(taskId, {
    subject: input.subject,
    status: "pending",
    activeForm: input.activeForm,
    description: input.description,
  });
}

export function applyTaskUpdate(state: TaskState, input: TaskUpdateInput | undefined): void {
  if (!input?.taskId) return;
  if (input.status === "deleted") {
    state.delete(input.taskId);
    return;
  }
  const existing = state.get(input.taskId);
  // Without a subject from either the existing entry or the update payload,
  // we'd produce a plan entry with empty `content` — drop the update.
  const subject = input.subject ?? existing?.subject;
  if (!subject) return;
  state.set(input.taskId, {
    subject,
    status: input.status ?? existing?.status ?? "pending",
    activeForm: input.activeForm ?? existing?.activeForm,
    description: input.description ?? existing?.description,
  });
}

export function taskStateToPlanEntries(state: TaskState): PlanEntry[] {
  return Array.from(state.values()).map((task) => ({
    content: task.subject,
    status: task.status,
    priority: "medium",
  }));
}

export function markdownEscape(text: string): string {
  let escape = "```";
  for (const [m] of text.matchAll(/^```+/gm)) {
    while (m.length >= escape.length) {
      escape += "`";
    }
  }
  return escape + "\n" + text + (text.endsWith("\n") ? "" : "\n") + escape;
}

interface DiffToolResponseHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface DiffToolResponse {
  filePath?: string;
  structuredPatch?: DiffToolResponseHunk[];
}

/**
 * Builds diff ToolUpdate content from the structured toolResponse provided by
 * the PostToolUse hook for diff-producing tools (Edit, Write). Unlike parsing
 * the plain unified diff string, this uses the pre-parsed structuredPatch
 * which supports multiple replacement sites (replaceAll) and always includes
 * context lines for better readability.
 */
export function toolUpdateFromDiffToolResponse(toolResponse: unknown): {
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
} {
  if (!toolResponse || typeof toolResponse !== "object") return {};
  const response = toolResponse as DiffToolResponse;
  if (!response.filePath || !Array.isArray(response.structuredPatch)) return {};

  const content: ToolCallContent[] = [];
  const locations: ToolCallLocation[] = [];

  for (const { lines, newStart } of response.structuredPatch) {
    const oldText: string[] = [];
    const newText: string[] = [];
    for (const line of lines) {
      if (line.startsWith("-")) {
        oldText.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newText.push(line.slice(1));
      } else {
        oldText.push(line.slice(1));
        newText.push(line.slice(1));
      }
    }
    if (oldText.length > 0 || newText.length > 0) {
      locations.push({ path: response.filePath, line: newStart });
      content.push({
        type: "diff",
        path: response.filePath,
        oldText: oldText.join("\n") || null,
        newText: newText.join("\n"),
      });
    }
  }

  const result: { content?: ToolCallContent[]; locations?: ToolCallLocation[] } = {};
  if (content.length > 0) result.content = content;
  if (locations.length > 0) result.locations = locations;
  return result;
}

/* A global variable to store callbacks that should be executed when receiving hooks from Claude Code */
const toolUseCallbacks: {
  [toolUseId: string]: {
    onPostToolUseHook?: (
      toolUseID: string,
      toolInput: unknown,
      toolResponse: unknown,
    ) => Promise<void>;
  };
} = {};

/* Setup callbacks that will be called when receiving hooks from Claude Code */
export const registerHookCallback = (
  toolUseID: string,
  {
    onPostToolUseHook,
  }: {
    onPostToolUseHook?: (
      toolUseID: string,
      toolInput: unknown,
      toolResponse: unknown,
    ) => Promise<void>;
  },
) => {
  toolUseCallbacks[toolUseID] = {
    onPostToolUseHook,
  };
};

/* A callback for Claude Code that is called when receiving a PostToolUse hook */
export const createPostToolUseHook =
  (options?: { onEnterPlanMode?: () => Promise<void> }): HookCallback =>
  async (input: any, toolUseID: string | undefined): Promise<{ continue: boolean }> => {
    if (input.hook_event_name === "PostToolUse") {
      // Handle EnterPlanMode tool - notify client of mode change after successful execution
      if (input.tool_name === "EnterPlanMode" && options?.onEnterPlanMode) {
        await options.onEnterPlanMode();
      }

      if (toolUseID) {
        const onPostToolUseHook = toolUseCallbacks[toolUseID]?.onPostToolUseHook;
        if (onPostToolUseHook) {
          await onPostToolUseHook(toolUseID, input.tool_input, input.tool_response);
        }
        delete toolUseCallbacks[toolUseID]; // Cleanup after execution
      }
    }
    return { continue: true };
  };

/**
 * Hook callback for `TaskCreated` / `TaskCompleted` events. The SDK fires
 * these for both user-facing TaskCreate tool calls and subagent task
 * creation, giving us `task_id` + `task_subject` without having to parse
 * tool_result payloads.
 *
 * Populating `taskState` from the hook means a later `TaskUpdate` (which
 * typically only carries `taskId` + `status`) finds an existing entry with
 * a real subject, instead of synthesizing a placeholder with empty content.
 */
export const createTaskHook =
  (options: { taskState: TaskState; onChange?: () => Promise<void> }): HookCallback =>
  async (input): Promise<{ continue: boolean }> => {
    const taskId =
      "task_id" in input && typeof input.task_id === "string" ? input.task_id : undefined;
    if (!taskId) return { continue: true };

    if (input.hook_event_name === "TaskCreated") {
      if (!input.task_subject) return { continue: true };
      if (options.taskState.has(taskId)) return { continue: true };
      options.taskState.set(taskId, {
        subject: input.task_subject,
        status: "pending",
        description: input.task_description,
      });
      if (options.onChange) await options.onChange();
    } else if (input.hook_event_name === "TaskCompleted") {
      const existing = options.taskState.get(taskId);
      if (!existing || existing.status === "completed") return { continue: true };
      options.taskState.set(taskId, { ...existing, status: "completed" });
      if (options.onChange) await options.onChange();
    }
    return { continue: true };
  };

function safePathPart(value: unknown): string {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function localTimestamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** Render the saved Explore result markdown. Mirrors the legacy command-hook
 *  script so the on-disk artifact looks identical regardless of which path
 *  produced it. */
function exploreResultMarkdown(input: {
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
  last_assistant_message?: string;
}): string {
  return [
    "# Explore subagent result",
    "",
    `- session_id: ${input.session_id || ""}`,
    `- agent_id: ${input.agent_id || ""}`,
    `- agent_type: ${input.agent_type || ""}`,
    `- agent_transcript_path: ${input.agent_transcript_path || ""}`,
    "",
    "## Final message",
    "",
    input.last_assistant_message || "",
  ].join("\n");
}

/**
 * Hook callback for `SubagentStop`. The headless Explore subagent never writes
 * to disk, so its final answer is lost to the feed (the streaming handler drops
 * subagent prose). To surface it the way Plan/Edit changes are surfaced, we
 * persist the final message under `<cwd>/.claude/explore-results/*.md` and emit
 * a `Write`-shaped `tool_call` carrying the structuredPatch — that is the only
 * signal the renderer's SessionChangeTracker records, so the saved result then
 * appears in the Session Changes view (and as a tool-call card in the timeline).
 *
 * Only `agent_type === "Explore"` is handled; other subagents pass through. A
 * write failure is logged and swallowed so it never aborts the turn.
 */
export const createSubagentStopHook =
  (options: {
    sessionId: string;
    cwd: string;
    sendUpdate: (notification: SessionNotification) => Promise<void>;
    logger?: Logger;
  }): HookCallback =>
  async (input): Promise<{ continue: boolean }> => {
    if (input.hook_event_name !== "SubagentStop") return { continue: true };
    if (!("agent_type" in input) || input.agent_type !== "Explore") return { continue: true };

    const message =
      "last_assistant_message" in input && typeof input.last_assistant_message === "string"
        ? input.last_assistant_message
        : "";
    if (message.trim().length === 0) return { continue: true };

    const agentId = "agent_id" in input && typeof input.agent_id === "string" ? input.agent_id : "";
    const transcriptPath =
      "agent_transcript_path" in input && typeof input.agent_transcript_path === "string"
        ? input.agent_transcript_path
        : "";

    try {
      const outDir = path.join(options.cwd, ".claude", "explore-results");
      fs.mkdirSync(outDir, { recursive: true });
      const baseName = `${localTimestamp()}-${safePathPart(options.sessionId)}-${safePathPart(agentId)}.md`;
      const outPath = path.join(outDir, baseName);
      const content = exploreResultMarkdown({
        session_id: options.sessionId,
        agent_id: agentId,
        agent_type: "Explore",
        agent_transcript_path: transcriptPath,
        last_assistant_message: message,
      });
      fs.writeFileSync(outPath, content, "utf8");

      // Build a creation diff: one hunk, every line added. This is the same
      // shape Edit/Write report via PostToolUse, so readStructuredPatch on the
      // client records it as an `added` Session Change.
      const lines = content.split("\n");
      const toolResponse = {
        filePath: outPath,
        type: "create",
        structuredPatch: [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: lines.length,
            lines: lines.map((l) => `+${l}`),
          },
        ],
      };
      const { content: diffContent } = toolUpdateFromDiffToolResponse(toolResponse);

      await options.sendUpdate({
        sessionId: options.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: `explore-result-${agentId || baseName}`,
          title: `Saved Explore result: ${baseName}`,
          kind: "edit",
          status: "completed",
          ...(diffContent && diffContent.length > 0 ? { content: diffContent } : {}),
          _meta: {
            claudeCode: {
              toolName: "Write",
              toolResponse,
            },
          } satisfies ToolUpdateMeta,
        },
      });
    } catch (err) {
      options.logger?.error(
        `[claude-agent-acp] Failed to save Explore result: ${(err as Error).message}`,
      );
    }
    return { continue: true };
  };

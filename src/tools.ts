import type {
  PlanEntry,
  SessionNotification,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type {
  TaskCreateInput,
  TaskCreateOutput,
  TaskListOutput,
  TaskUpdateInput,
  TaskUpdateOutput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { ClientCapabilities } from "./tool-calls/client-capabilities.js";
import type { ToolResultBlock } from "./tool-calls/content.js";
import { structuredResult } from "./tool-calls/content.js";
import { AcpToolCallRenderer, type RenderedResult } from "./tool-calls/renderer.js";

export { markdownEscape, toDisplayPath } from "./tool-calls/content.js";
import fs from "node:fs";
import path from "node:path";
import { toolUpdateFromDiffToolResponse } from "./diff.js";
import { Logger, type ToolUpdateMeta } from "./acp-agent.js";

/**
 * The title, kind, content, and locations of a tool use, for a client with the
 * given terminal and patch capabilities. The {@link AcpToolCallRenderer} builds
 * them from the facts of the tool reporter.
 */
export function toolInfoFromToolUse(
  toolUse: any,
  supportsTerminalOutput: boolean = false,
  cwd?: string,
  supportsDiffPatch: boolean = false,
): {
  title: string;
  kind: ToolKind;
  content: ToolCallContent[];
  locations?: ToolCallLocation[];
} {
  const renderer = new AcpToolCallRenderer(
    new ClientCapabilities(supportsTerminalOutput, false, supportsDiffPatch),
  );
  return renderer.toolInfo({ id: toolUse?.id, name: toolUse?.name, input: toolUse?.input }, cwd);
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

/**
 * The result fields of a tool result, for a client with the given terminal
 * capabilities. The {@link AcpToolCallRenderer} builds them from the facts of
 * the tool reporter.
 */
export function toolUpdateFromToolResult(
  toolResult: ToolResultBlock,
  toolUse: any | undefined,
  supportsTerminalOutput: boolean = false,
  toolUseResult?: unknown,
  preferTerminalOutputDelta: boolean = false,
): RenderedResult {
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
  const renderer = new AcpToolCallRenderer(
    new ClientCapabilities(supportsTerminalOutput, preferTerminalOutputDelta),
  );
  return renderer.resultFields(
    { id: toolUse?.id, name: toolUse?.name ?? "", input: toolUse?.input },
    toolResult as Parameters<AcpToolCallRenderer["resultFields"]>[1],
    toolUseResult,
  );
}

export type ClaudePlanEntry = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
};

export function planEntries(input: { todos: ClaudePlanEntry[] } | undefined): PlanEntry[] {
  return (input?.todos ?? []).map((todo) => ({
    content: todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content,
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
 * Running token + model tally for one sub-agent (Task/Agent tool), accumulated
 * across every assistant message the sub-agent produces. The SDK reports these
 * per-message (`message.usage` / `message.model` / `subagent_type`) but never a
 * per-sub-agent cost breakdown, so the client prices the tally locally.
 */
export type SubagentStatsEntry = {
  /** Latest model id seen on this sub-agent's messages. */
  model?: string;
  /** SDK `subagent_type` (the registered agent type), if reported. */
  subagentType?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /**
   * Internal last-seen usage snapshot per API message id — the dedupe ledger
   * accumulateSubagentUsage uses to replace, not re-add, the earlier frames the
   * SDK streams for one message. Pure bookkeeping: `subagentStatsToMeta` picks
   * fields explicitly, so this never reaches `_meta` serialization.
   */
  perMessage?: Map<
    string,
    { input: number; output: number; cacheRead: number; cacheCreate: number }
  >;
};

/** Per-session sub-agent tallies keyed by the parent tool_use id. */
export type SubagentStatsState = Map<string, SubagentStatsEntry>;

/** Raw Anthropic usage block carried on an assistant message. */
type SubagentUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/**
 * Fold one sub-agent assistant message's usage/model into the tally for its
 * parent tool call. Token counts accumulate across the sub-agent's turns; the
 * model / subagent_type are last-write-wins (a sub-agent uses one model).
 *
 * The SDK streams ONE API message as several assistant frames whose usage
 * block is a point-in-time SNAPSHOT, not a delta — and gateways disagree on
 * the shape (Moonshot/kimi lead with all-zero frames, Anthropic/deepseek
 * repeat the full usage every frame). Frames carrying `messageId` therefore
 * don't accumulate: the newest snapshot for an id REPLACES the previous
 * frame's contribution (ledgered in `perMessage`), so kimi's zero-lead ends
 * at the final frame's real numbers while deepseek isn't counted once per
 * frame. Frames without an id keep the legacy plain accumulation.
 *
 * No-op when the usage carries no positive tokens and no new metadata, so
 * empty frames don't manufacture hollow entries — an all-zero snapshot
 * subtracts nothing when a later frame of the same id replaces it anyway.
 */
export function accumulateSubagentUsage(
  state: SubagentStatsState,
  parentToolUseId: string,
  fields: {
    usage?: SubagentUsage | null;
    model?: string | null;
    subagentType?: string | null;
    messageId?: string | null;
  },
): void {
  const u = fields.usage;
  const rawInput = num(u?.input_tokens);
  const rawOutput = num(u?.output_tokens);
  const rawCacheRead = num(u?.cache_read_input_tokens);
  const rawCacheCreate = num(u?.cache_creation_input_tokens);
  let input = rawInput;
  let output = rawOutput;
  let cacheRead = rawCacheRead;
  let cacheCreate = rawCacheCreate;
  const existing = state.get(parentToolUseId);
  const messageId =
    typeof fields.messageId === "string" && fields.messageId.length > 0
      ? fields.messageId
      : undefined;
  if (messageId !== undefined) {
    const prev = existing?.perMessage?.get(messageId);
    if (prev !== undefined) {
      // Replace, don't re-add: subtract the earlier snapshot of this same API
      // message before folding in the newer one.
      input -= prev.input;
      output -= prev.output;
      cacheRead -= prev.cacheRead;
      cacheCreate -= prev.cacheCreate;
    }
  }
  const model =
    typeof fields.model === "string" && fields.model.length > 0 && fields.model !== "<synthetic>"
      ? fields.model
      : existing?.model;
  const subagentType =
    typeof fields.subagentType === "string" && fields.subagentType.length > 0
      ? fields.subagentType
      : existing?.subagentType;
  // Nothing to add and no new metadata → don't manufacture an entry.
  if (
    !existing &&
    input + output + cacheRead + cacheCreate === 0 &&
    model === undefined &&
    subagentType === undefined
  ) {
    return;
  }
  const next: SubagentStatsEntry = {
    ...(model !== undefined ? { model } : {}),
    ...(subagentType !== undefined ? { subagentType } : {}),
    inputTokens: (existing?.inputTokens ?? 0) + input,
    outputTokens: (existing?.outputTokens ?? 0) + output,
    cacheReadTokens: (existing?.cacheReadTokens ?? 0) + cacheRead,
    cacheCreateTokens: (existing?.cacheCreateTokens ?? 0) + cacheCreate,
  };
  if (messageId !== undefined) {
    const perMessage = existing?.perMessage ?? new Map();
    perMessage.set(messageId, {
      input: rawInput,
      output: rawOutput,
      cacheRead: rawCacheRead,
      cacheCreate: rawCacheCreate,
    });
    next.perMessage = perMessage;
  } else if (existing?.perMessage !== undefined) {
    next.perMessage = existing.perMessage;
  }
  state.set(parentToolUseId, next);
}

/** Serialize one sub-agent tally into the `_meta._universe/subagentStats` shape. */
export function subagentStatsToMeta(entry: SubagentStatsEntry): Record<string, unknown> {
  return {
    ...(entry.model !== undefined ? { model: entry.model } : {}),
    ...(entry.subagentType !== undefined ? { subagentType: entry.subagentType } : {}),
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheReadTokens: entry.cacheReadTokens,
    cacheCreateTokens: entry.cacheCreateTokens,
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
<<<<<<< HEAD
 * Best-effort parse of a structured Task* tool_result. The SDK delivers tool
 * outputs either as a string or as an array of TextBlockParam-like blocks
 * containing JSON text; try both.
=======
 * Identify a replayed, completed Task/Agent tool_result row and extract the
 * sub-agent's identity from its message-level `tool_use_result` sidecar
 * (AgentOutput). The sidecar's own `usage` only covers the sub-agent's FINAL
 * API call — the CLI folds the run down to its result — so it wildly
 * understates the real spend; the true tally must be re-accumulated from the
 * sub-agent's own transcript, which `agentId` locates. Returns undefined for
 * non-Task tools or older CLIs without the sidecar.
 */
export function replayedSubagentCardFromResult(
  content: unknown,
  toolUseResult: unknown,
  toolUseCache: { [key: string]: { name: string } | undefined },
): { toolCallId: string; agentId: string; agentType?: string } | undefined {
  if (!Array.isArray(content)) return undefined;
  const structured = structuredResult<{ agentId?: unknown; agentType?: unknown }>(toolUseResult);
  if (structured == null) return undefined;
  const agentId = structured.agentId;
  if (typeof agentId !== "string" || agentId.length === 0) return undefined;
  for (const block of content) {
    if (block == null || typeof block !== "object") continue;
    const b = block as { type?: unknown; tool_use_id?: unknown };
    if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
    const name = toolUseCache[b.tool_use_id]?.name;
    if (name !== "Agent" && name !== "Task") continue;
    return {
      toolCallId: b.tool_use_id,
      agentId,
      ...(typeof structured.agentType === "string" && structured.agentType.length > 0
        ? { agentType: structured.agentType }
        : {}),
    };
  }
  return undefined;
}

/**
 * Re-accumulate a sub-agent's tally from its own transcript file
 * (`<session>/subagents/agent-<agentId>.jsonl`), folding every assistant
 * turn's usage exactly like the live accumulateSubagentUsage path — each
 * turn's cache reads bill separately, so only the sum matches the real
 * spend. The transcript holds 2-5 snapshot rows per API message id (the
 * streaming frames persisted), so rows are deduped by `message.id` exactly
 * like live frames are: the last snapshot of each message wins, otherwise
 * the tally reads 2-3x high. Lines are textually prefiltered before
 * JSON.parse: the transcript's biggest rows are tool_result user rows we
 * don't need. Returns undefined when no usage was found (a wrong number is
 * worse than none).
 */
export function subagentTallyFromTranscript(
  raw: string,
  agentType?: string,
): SubagentStatsEntry | undefined {
  const state: SubagentStatsState = new Map();
  const KEY = "tally";
  for (const line of raw.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed == null || typeof parsed !== "object") continue;
    const entry = parsed as {
      type?: unknown;
      message?: {
        id?: unknown;
        usage?: SubagentUsage | null;
        model?: string | null;
      } | null;
    };
    if (entry.type !== "assistant" || entry.message == null) continue;
    accumulateSubagentUsage(state, KEY, {
      usage: entry.message.usage,
      model: entry.message.model,
      ...(agentType !== undefined ? { subagentType: agentType } : {}),
      ...(typeof entry.message.id === "string" ? { messageId: entry.message.id } : {}),
    });
  }
  const tally = state.get(KEY);
  if (tally === undefined) return undefined;
  const total =
    tally.inputTokens + tally.outputTokens + tally.cacheReadTokens + tally.cacheCreateTokens;
  return total > 0 ? tally : undefined;
}

/**
 * One display-able entry extracted from a sub-agent's sidecar transcript
 * (`<session>/subagents/agent-<agentId>.jsonl`), shaped for replay through
 * toAcpNotifications. `content` mirrors the API message's `content` field
 * (already filtered per the rules below); `model`/`messageId` are carried for
 * the synthetic-placeholder predicates and message grouping the replayer uses.
 */
export type SubagentReplayEntry = {
  role: "user" | "assistant";
  content: unknown;
  model?: string;
  messageId?: string;
};

/**
 * Parse a sub-agent's sidecar transcript into the ordered display entries the
 * live stream would have nested under the parent Task card.
 *
 * Live, the SDK streams each sub-agent turn as a sidechain message tagged with
 * `parent_tool_use_id`; the client nests those under the parent card as they
 * arrive. The parent-chain replay never sees that sidechain — its rows live in
 * this file — so replay re-emits them from here, in file order, to restore
 * exactly what the user saw live.
 *
 * Line handling mirrors subagentTallyFromTranscript: bad JSON is skipped, not
 * fatal. Rows are kept in file order and filtered to:
 * - `type` "user" | "assistant" with a non-empty `message`;
 * - not `isMeta` / carrying a `teamName`, and NOT itself a nested sidechain
 *   row (its own `parent_tool_use_id`): the client renders only one level of
 *   nesting, so sub-sub-agents don't replay. Every row in this file is
 *   naturally stamped `isSidechain: true` (sidecar rows are sidechain by
 *   definition) — unlike the parent transcript's display-chain filter, that
 *   flag must never gate replay here;
 * - user rows keep only their `tool_result` blocks: live, a sub-agent's
 *   initial user prompt never reaches the client feed (the parent card already
 *   shows the Task input), so a user row whose content is a plain string or
 *   text blocks (the initial prompt) is dropped entirely;
 * - assistant rows pass `content` through untouched, with `messageId` from
 *   `message.id` and `model` from `message.model`.
 */
export function subagentReplayEntriesFromTranscript(raw: string): SubagentReplayEntry[] {
  const entries: SubagentReplayEntry[] = [];
  for (const line of raw.split("\n")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed == null || typeof parsed !== "object") continue;
    const row = parsed as {
      type?: unknown;
      isMeta?: unknown;
      isSidechain?: unknown;
      teamName?: unknown;
      parent_tool_use_id?: unknown;
      message?: {
        role?: unknown;
        content?: unknown;
        model?: unknown;
        id?: unknown;
      } | null;
    };
    if (row.type !== "user" && row.type !== "assistant") continue;
    if (row.isMeta === true) continue;
    if (row.teamName !== undefined) continue;
    if (typeof row.parent_tool_use_id === "string" && row.parent_tool_use_id.length > 0) {
      continue;
    }
    const message = row.message;
    if (message == null || typeof message !== "object") continue;
    if (message.content === undefined) continue;
    if (row.type === "user") {
      if (!Array.isArray(message.content)) continue;
      const content = message.content.filter(
        (block) =>
          block != null &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "tool_result",
      );
      if (content.length === 0) continue;
      entries.push({ role: "user", content });
    } else {
      entries.push({
        role: "assistant",
        content: message.content,
        ...(typeof message.model === "string" ? { model: message.model } : {}),
        ...(typeof message.id === "string" ? { messageId: message.id } : {}),
      });
    }
  }
  return entries;
}

/**
 * Best-effort parse of a TaskCreate tool_result content into the structured
 * TaskCreateOutput. The SDK delivers tool outputs either as a string or as
 * an array of TextBlockParam-like blocks containing JSON text; try both.
>>>>>>> 633d221 (feat: 回放时，可以正确统计子agent的token开销)
 * Headless claude-code (>= 2.1.220) instead emits prose ("Task #1 created
 * successfully: <subject>") with the structured data on the message-level
 * tool_use_result sidecar — fall back to matching that prose so history
 * replay can rebuild the plan when the sidecar is unavailable.
 */
function parseJsonToolOutput<T>(
  content: unknown,
  isExpectedOutput: (value: unknown) => value is T,
): T | undefined {
  const tryParse = (text: string): T | undefined => {
    try {
      const parsed: unknown = JSON.parse(text);
      return isExpectedOutput(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  if (typeof content === "string") {
    return tryParse(content);
  }
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return isExpectedOutput(content) ? content : undefined;
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

function toolOutputTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    block &&
    typeof block === "object" &&
    "type" in block &&
    block.type === "text" &&
    "text" in block &&
    typeof block.text === "string"
      ? [block.text]
      : [],
  );
}

export function parseTaskCreateOutput(content: unknown): TaskCreateOutput | undefined {
  const structured = parseJsonToolOutput(content, (parsed): parsed is TaskCreateOutput =>
    Boolean(
      parsed &&
      typeof parsed === "object" &&
      "task" in parsed &&
      parsed.task &&
      typeof parsed.task === "object" &&
      "id" in parsed.task &&
      typeof parsed.task.id === "string",
    ),
  );
  if (structured) return structured;

  for (const text of toolOutputTexts(content)) {
    const match = /^Task #(\S+) created successfully: (.+)$/.exec(text.trim());
    if (match) return { task: { id: match[1], subject: match[2] } };
  }
  return undefined;
}

export function parseTaskListOutput(content: unknown): TaskListOutput | undefined {
  const validStatuses = new Set(["pending", "in_progress", "completed"]);
  const structured = parseJsonToolOutput(content, (parsed): parsed is TaskListOutput =>
    Boolean(
      parsed &&
      typeof parsed === "object" &&
      "tasks" in parsed &&
      Array.isArray(parsed.tasks) &&
      parsed.tasks.every(
        (task) =>
          task &&
          typeof task === "object" &&
          typeof task.id === "string" &&
          typeof task.subject === "string" &&
          typeof task.status === "string" &&
          validStatuses.has(task.status),
      ),
    ),
  );
  if (structured) return structured;

  for (const text of toolOutputTexts(content)) {
    if (text.trim() === "No tasks found") return { tasks: [] };

    const tasks: TaskListOutput["tasks"] = [];
    const lines = text.trim().split("\n");
    for (const line of lines) {
      const match = /^#(\S+) \[(pending|in_progress|completed)\] (.+)$/.exec(line);
      if (!match) {
        tasks.length = 0;
        break;
      }

      let subject = match[3];
      let owner: string | undefined;
      let blockedBy: string[] = [];

      const blockedMarker = " [blocked by ";
      const blockedStart = subject.lastIndexOf(blockedMarker);
      if (blockedStart > 0 && subject.endsWith("]")) {
        const dependencies = subject.slice(blockedStart + blockedMarker.length, -1).split(", ");
        if (
          dependencies.every(
            (dependency) =>
              dependency.length > 1 &&
              dependency.startsWith("#") &&
              !dependency.includes(",") &&
              !dependency.includes("]"),
          )
        ) {
          subject = subject.slice(0, blockedStart);
          blockedBy = dependencies.map((dependency) => dependency.slice(1));
        }
      }

      const ownerStart = subject.lastIndexOf(" (");
      if (ownerStart > 0 && subject.endsWith(")")) {
        const candidate = subject.slice(ownerStart + 2, -1);
        if (!candidate.includes("(") && !candidate.includes(")")) {
          subject = subject.slice(0, ownerStart);
          owner = candidate || undefined;
        }
      }

      tasks.push({
        id: match[1],
        subject,
        status: match[2] as TaskListOutput["tasks"][number]["status"],
        ...(owner ? { owner } : {}),
        blockedBy,
      });
    }
    if (tasks.length > 0) return { tasks };
  }
  return undefined;
}

export function parseTaskUpdateOutput(
  content: unknown,
  expectedTaskId?: string,
): TaskUpdateOutput | undefined {
  const structured = parseJsonToolOutput(content, (parsed): parsed is TaskUpdateOutput =>
    Boolean(
      parsed &&
      typeof parsed === "object" &&
      "success" in parsed &&
      typeof parsed.success === "boolean" &&
      "taskId" in parsed &&
      typeof parsed.taskId === "string" &&
      "updatedFields" in parsed &&
      Array.isArray(parsed.updatedFields) &&
      parsed.updatedFields.every((field) => typeof field === "string"),
    ),
  );
  if (structured) return structured;

  for (const text of toolOutputTexts(content)) {
    const notFound = /^Task #(\S+) not found$/.exec(text.trim());
    const taskId = notFound?.[1] ?? expectedTaskId;
    if (taskId && (notFound || text.trim() === "Failed to delete task")) {
      return { success: false, taskId, updatedFields: [], error: text.trim() };
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
  const subject = input.subject ?? existing?.subject ?? `Task #${input.taskId}`;
  state.set(input.taskId, {
    subject,
    status: input.status ?? existing?.status ?? "pending",
    activeForm: input.activeForm ?? existing?.activeForm,
    description: input.description ?? existing?.description,
  });
}

export function applyTaskList(state: TaskState, output: TaskListOutput): void {
  const previous = new Map(state);
  state.clear();
  for (const task of output.tasks) {
    const existing = previous.get(task.id);
    state.set(task.id, {
      subject: task.subject,
      status: task.status,
      activeForm: existing?.activeForm,
      description: existing?.description,
    });
  }
}

export function taskStateToPlanEntries(state: TaskState): PlanEntry[] {
  return Array.from(state.values()).map((task) => ({
    content: task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject,
    status: task.status,
    priority: "medium",
  }));
}

/** The plan entries that the client holds for each task list, as JSON. */
const publishedTaskPlans = new WeakMap<TaskState, string>();

/**
 * The plan entries of the task list, or undefined when the client already
 * holds the same entries. The TaskCreated and TaskCompleted hooks and the
 * Task* tool results report the same change, so the second report of a
 * change has nothing new.
 *
 * Only an AIR client skips the repeated plan. Every other client gets every
 * plan, like upstream.
 */
export function changedTaskPlanEntries(
  state: TaskState,
  airClient: boolean,
): PlanEntry[] | undefined {
  const entries = taskStateToPlanEntries(state);
  if (!airClient) return entries;
  const json = JSON.stringify(entries);
  if (publishedTaskPlans.get(state) === json) return undefined;
  publishedTaskPlans.set(state, json);
  return entries;
}

/** Forgets the plan that the client holds, so that the next plan goes out, for example on replay. */
export function forgetPublishedTaskPlan(state: TaskState): void {
  publishedTaskPlans.delete(state);
}

/* Callbacks are keyed globally because the SDK hook is process-wide, but each
 * entry retains its owning ACP session so cancellation/teardown can release it. */
const toolUseCallbacks = new Map<
  string,
  {
    ownerId?: string;
    cleanupTimer?: ReturnType<typeof setTimeout>;
    onPostToolUseHook?: (
      toolUseID: string,
      toolInput: unknown,
      toolResponse: unknown,
    ) => Promise<void>;
    onRelease?: () => void;
  }
>();

/* Setup callbacks that will be called when receiving hooks from Claude Code.
 * `onRelease` runs once when the callback leaves the registry: after the hook
 * fired, after the grace period, or at session teardown. */
export const registerHookCallback = (
  toolUseID: string,
  {
    onPostToolUseHook,
    onRelease,
  }: {
    onPostToolUseHook?: (
      toolUseID: string,
      toolInput: unknown,
      toolResponse: unknown,
    ) => Promise<void>;
    onRelease?: () => void;
  },
  ownerId?: string,
) => {
  unregisterHookCallback(toolUseID);
  toolUseCallbacks.set(toolUseID, {
    ownerId,
    onPostToolUseHook,
    onRelease,
  });
};

export function unregisterHookCallback(toolUseID: string): void {
  const callback = toolUseCallbacks.get(toolUseID);
  if (callback?.cleanupTimer) clearTimeout(callback.cleanupTimer);
  toolUseCallbacks.delete(toolUseID);
  callback?.onRelease?.();
}

/** Whether a PostToolUse callback for the tool use is still registered. */
export function hasHookCallback(toolUseID: string): boolean {
  return toolUseCallbacks.has(toolUseID);
}

/** PostToolUse normally follows tool_result, so keep the callback for a short
 * grace period while still bounding retention when the hook never arrives. */
export function completeHookCallback(toolUseID: string): void {
  const callback = toolUseCallbacks.get(toolUseID);
  if (!callback || callback.cleanupTimer) return;
  callback.cleanupTimer = setTimeout(() => unregisterHookCallback(toolUseID), 30_000);
  callback.cleanupTimer.unref?.();
}

export function clearHookCallbacks(ownerId: string): void {
  for (const [toolUseID, callback] of toolUseCallbacks) {
    if (callback.ownerId === ownerId) unregisterHookCallback(toolUseID);
  }
}

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
        const onPostToolUseHook = toolUseCallbacks.get(toolUseID)?.onPostToolUseHook;
        try {
          if (onPostToolUseHook) {
            await onPostToolUseHook(toolUseID, input.tool_input, input.tool_response);
          }
        } finally {
          unregisterHookCallback(toolUseID);
        }
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

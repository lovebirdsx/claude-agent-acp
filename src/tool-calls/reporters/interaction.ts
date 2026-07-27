import type {
  AskUserQuestionInput,
  AskUserQuestionOutput,
  ReportFindingsInput,
  TaskCreateInput,
  TaskUpdateInput,
  TodoWriteInput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exitPlanModeRawOutput } from "../../exit-plan.js";
import { resultText, structuredResult, textContent, toAcpContentUpdate } from "../content.js";
import type {
  ToolReporter,
  ToolResultContext,
  ToolResultFacts,
  ToolUseContext,
  ToolUseFacts,
} from "../facts.js";

/**
 * ExitPlanMode: the plan is input that the user approves.
 *
 * Claude writes the plan to a file under `plansDirectory` while it drafts it.
 * The CLI adds the file text as `plan` and the file path as `planFilePath` to
 * the complete input. A `planFile` client gets the path and reads the plan
 * from the file. Without the file, it gets the plan text like other clients.
 */
export class ExitPlanModeReporter implements ToolReporter {
  toolUse(input: unknown, { capabilities }: ToolUseContext): ToolUseFacts {
    const plan = (input as { plan?: string } | undefined)?.plan;
    const planFilePath = capabilities.air.planFile
      ? existingPlanFile((input as { planFilePath?: unknown } | undefined)?.planFilePath)
      : undefined;
    return {
      title: "Approve Plan",
      kind: "switch_mode",
      ...(planFilePath ? { planFilePath } : plan ? { display: [textContent(plan)] } : {}),
    };
  }

  /** The approval text repeats the plan, which the input holds. */
  toolResult(context: ToolResultContext): ToolResultFacts {
    const planFilePath = resultPlanFile(context);
    return {
      title: "Exited Plan Mode",
      rawOutput: undefined,
      ...(planFilePath ? { planFilePath, planFileReleased: true } : {}),
    };
  }

  /**
   * The rejection reason has no display form. Claude fences it, so unfence it.
   * A client that is not AIR gets the error text as the result to show.
   */
  errorResult(context: ToolResultContext): ToolResultFacts | undefined {
    const { toolUse, result, capabilities } = context;
    if (!capabilities.air.client) return undefined;
    const planFilePath = resultPlanFile(context);
    return {
      rawOutput: exitPlanModeRawOutput(toolUse.name, result.content),
      ...(planFilePath ? { planFilePath } : {}),
    };
  }
}

/** The plan file of a result: the path of the input, else the `filePath` of the structured result. */
function resultPlanFile({ toolUse, structured, capabilities }: ToolResultContext) {
  if (!capabilities.air.planFile) return undefined;
  return (
    existingPlanFile((toolUse.input as { planFilePath?: unknown } | undefined)?.planFilePath) ??
    existingPlanFile((structured as { filePath?: unknown } | undefined)?.filePath)
  );
}

/** The path when it is an absolute path of a regular file, else undefined. */
function existingPlanFile(value: unknown): string | undefined {
  if (typeof value !== "string" || !path.isAbsolute(value)) return undefined;
  try {
    return statSync(value).isFile() ? value : undefined;
  } catch {
    return undefined;
  }
}

/** AskUserQuestion: the questions are input that the user reads. */
export class AskUserQuestionReporter implements ToolReporter {
  /**
   * AIR gets a fixed title, because the question is input. Every other client
   * gets the question of a single question as the title, like upstream.
   */
  toolUse(input: unknown, { capabilities }: ToolUseContext): ToolUseFacts {
    const ask = input as Partial<AskUserQuestionInput> | undefined;
    const questions = Array.isArray(ask?.questions) ? ask.questions : [];
    const display = questions
      .filter((q) => typeof q?.question === "string")
      .map((q) => textContent(q.question));
    const single =
      !capabilities.air.client && questions.length === 1 && questions[0]?.question
        ? questions[0].question
        : undefined;
    return {
      title: single ?? "Asking for your input",
      kind: "other",
      ...(display.length > 0 ? { display } : {}),
    };
  }

  /**
   * The raw tool_result text is one model-directed blob: every question and
   * its answer flattened into a single line, plus a trailer meant only for the
   * model. Rebuild a readable per-question view: prefer the structured
   * AskUserQuestionOutput; on replayed sessions `tool_use_result` is absent,
   * so fall back to re-slicing the raw blob using the structured questions
   * from the cached tool_use as anchors.
   */
  toolResult({ toolUse, result, structured }: ToolResultContext): ToolResultFacts {
    const text =
      formatAskUserQuestionResult(structuredResult<AskUserQuestionOutput>(structured)) ??
      parseRawAskUserQuestionResult(
        flattenRawText(result.content),
        (toolUse.input as Partial<AskUserQuestionInput> | undefined)?.questions,
      );
    return text === undefined ? resultText(result) : { content: [textContent(text)] };
  }
}

interface AskAnswerEntry {
  readonly question: string;
  /** Absent/empty means the user skipped the question. */
  readonly answer?: string;
  readonly notes?: string;
}

/** One display section per question: quoted question, then the bold answer.
 *  Answers/questions are natural language — embedded markdown (inline code
 *  etc.) renders fine in the client's chat view, so pass it through. */
function renderAskSections(entries: readonly AskAnswerEntry[]): string {
  return entries
    .map((entry) => {
      const lines = [quoteLines(entry.question)];
      lines.push(
        `**答案**：${
          entry.answer !== undefined && entry.answer.length > 0 ? entry.answer : "（跳过）"
        }`,
      );
      if (entry.notes !== undefined && entry.notes.length > 0) {
        lines.push(`**补充**：${entry.notes}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * Rebuild the AskUserQuestion tool_result from its structured output. Returns
 * undefined when the structured output is missing or off-shape (replayed
 * sessions don't carry tool_use_result), so the caller falls back to
 * {@link parseRawAskUserQuestionResult}. `annotations[question].notes`
 * carries a free-text note the user attached to their pick; `response` is a
 * whole-form free-text reply — both surface when present.
 */
function formatAskUserQuestionResult(
  output: AskUserQuestionOutput | undefined,
): string | undefined {
  if (
    output === undefined ||
    !Array.isArray(output.questions) ||
    output.questions.length === 0 ||
    output.answers === null ||
    typeof output.answers !== "object"
  ) {
    return undefined;
  }
  const entries: AskAnswerEntry[] = [];
  for (const question of output.questions) {
    if (typeof question?.question !== "string") {
      continue;
    }
    const answer = output.answers[question.question];
    const notes = output.annotations?.[question.question]?.notes;
    entries.push({
      question: question.question,
      ...(typeof answer === "string" ? { answer } : {}),
      ...(typeof notes === "string" && notes.length > 0 ? { notes } : {}),
    });
  }
  if (entries.length === 0) {
    return undefined;
  }
  const body = renderAskSections(entries);
  const response = output.response;
  return typeof response === "string" && response.length > 0
    ? `${body}\n\n**回答**：${response}`
    : body;
}

/**
 * Replay fallback for {@link formatAskUserQuestionResult}: re-slice the raw
 * model-facing blob (`… answered: "Q"="A", "Q"="A". <trailer>`) using the
 * structured question list from the cached tool_use as anchors. The blob's
 * prefix/trailer prose varies across CLI versions, so the parse keys only on
 * the `"Q"="A"` quoting structure: each answer runs from its question's
 * anchor to the next question's anchor — or, for the last one, to the blob's
 * closing quote (the known trailers carry no `"`). Any mismatch (question
 * edited/escaped in the blob, unexpected shape) discards the whole parse and
 * the caller renders the raw blob, no worse than before.
 */
function parseRawAskUserQuestionResult(
  rawText: string | undefined,
  questions: ReadonlyArray<{ question?: unknown }> | undefined,
): string | undefined {
  if (rawText === undefined || !Array.isArray(questions) || questions.length === 0) {
    return undefined;
  }
  const entries: AskAnswerEntry[] = [];
  let from = 0;
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i]?.question;
    if (typeof question !== "string" || question.length === 0) {
      return undefined;
    }
    const anchor = `"${question}"="`;
    const at = rawText.indexOf(anchor, from);
    if (at === -1) {
      return undefined;
    }
    const answerStart = at + anchor.length;
    let answerEnd: number;
    if (i + 1 < questions.length) {
      const nextQuestion = questions[i + 1]?.question;
      if (typeof nextQuestion !== "string" || nextQuestion.length === 0) {
        return undefined;
      }
      const next = rawText.indexOf(`", "${nextQuestion}"="`, answerStart);
      if (next === -1) {
        return undefined;
      }
      answerEnd = next;
      from = next + 3;
    } else {
      answerEnd = rawText.lastIndexOf('"');
      if (answerEnd < answerStart) {
        return undefined;
      }
    }
    entries.push({ question, answer: rawText.slice(answerStart, answerEnd) });
  }
  return entries.length > 0 ? renderAskSections(entries) : undefined;
}

/** Flatten a tool_result's content (plain string or block array) to text. */
function flattenRawText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const texts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      texts.push((block as { text: string }).text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/** Prefix every line with `> ` so a multi-line text stays a single quote block. */
function quoteLines(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Skill: the skill name is the label. The result is a confirmation. */
export class SkillReporter implements ToolReporter {
  toolUse(input: unknown): ToolUseFacts {
    const skill = (input as { skill?: string } | undefined)?.skill;
    return { title: skill ? `Load skill: ${skill}` : "Load skill", kind: "other" };
  }

  toolResult(): ToolResultFacts {
    return {};
  }
}

/**
 * TodoWrite and the Task* tools. The stream reports them as a plan. Only a
 * permission request surfaces them as a tool call.
 */
export class PlanToolReporter implements ToolReporter {
  constructor(private readonly toolName: string) {}

  toolUse(input: unknown): ToolUseFacts {
    switch (this.toolName) {
      case "TodoWrite": {
        const todos = (input as TodoWriteInput | undefined)?.todos;
        return {
          title: Array.isArray(todos)
            ? `Update TODOs: ${todos.map((todo: any) => todo.content).join(", ")}`
            : "Update TODOs",
          kind: "think",
        };
      }
      case "TaskCreate": {
        const subject = (input as TaskCreateInput | undefined)?.subject;
        return { title: subject ? `Create task: ${subject}` : "Create task", kind: "think" };
      }
      case "TaskUpdate": {
        const subject = (input as TaskUpdateInput | undefined)?.subject;
        return { title: subject ? `Update task: ${subject}` : "Update task", kind: "think" };
      }
      case "TaskList":
        return { title: "List tasks", kind: "think" };
      default:
        return { title: "Get task", kind: "think" };
    }
  }
}

/** ReportFindings: the findings are input that the user reads. */
export class ReportFindingsReporter implements ToolReporter {
  toolUse(input: unknown): ToolUseFacts {
    const findings = (input as ReportFindingsInput | undefined)?.findings ?? [];
    return {
      title:
        findings.length === 0
          ? "Report findings: none found"
          : `Report ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
      kind: "think",
      ...(findings.length > 0
        ? {
            display: findings.map((finding) =>
              textContent(
                `**${finding.file}${finding.line ? `:${finding.line}` : ""}** — ${finding.summary}`,
              ),
            ),
          }
        : {}),
    };
  }
}

/** Every other tool, MCP tools too: the result text is the result to show. */
export class GenericReporter implements ToolReporter {
  constructor(private readonly toolName: string) {}

  toolUse(input: unknown): ToolUseFacts {
    if (this.toolName !== "Other") {
      return { title: this.toolName || "Unknown Tool", kind: "other" };
    }
    let json;
    try {
      json = JSON.stringify(input, null, 2);
    } catch {
      json = typeof input === "string" ? input : "{}";
    }
    return {
      title: this.toolName,
      kind: "other",
      display: [textContent(`\`\`\`json\n${json}\`\`\``)],
    };
  }
}

/**
 * An agent control tool (SendMessage, TaskStop, ListAgents, Monitor). AIR
 * shows the result in its own frame and parses the JSON result of SendMessage
 * and TaskStop. So AIR gets the error text as plain text, without a fence.
 * A client that is not AIR gets the fenced error text.
 */
export class AgentControlReporter extends GenericReporter {
  errorResult({ result, capabilities }: ToolResultContext): ToolResultFacts | undefined {
    return capabilities.air.client ? toAcpContentUpdate(result.content, false) : undefined;
  }
}

/** Roots a skill's directory may sit under, relative to the directory the scope resolves to. */
const SKILL_CONTAINER_DIRS = [".claude/skills", ".agents/skills"] as const;

/**
 * Absolute path of a skill's `SKILL.md`, or `undefined` when none of the known layouts holds one.
 *
 * The `Skill` tool reports only the skill's name, so the file has to be located by probing the layouts skills
 * actually use: project- and user-level `.claude/skills` (plus this repo's `.agents/skills` source of truth), and
 * for a `<prefix>:<name>` spelling either a plugin (`.claude/plugins/<prefix>/skills/<name>`) or a
 * directory-scoped skill (`<prefix>/.claude/skills/<name>`), which share that spelling. Only a path that exists
 * on disk is returned, so a wrong guess costs nothing and clients never render a link to a missing file.
 */
export function resolveSkillPath(skillName: string, cwd?: string): string | undefined {
  if (!cwd) {
    return undefined;
  }
  const colon = skillName.indexOf(":");
  const scope = colon < 0 ? undefined : skillName.slice(0, colon);
  const name = colon < 0 ? skillName : skillName.slice(colon + 1);
  if (!name) {
    return undefined;
  }
  const candidates: string[] = [];
  const addCandidates = (base: string) => {
    for (const container of SKILL_CONTAINER_DIRS) {
      candidates.push(path.join(base, container, name, "SKILL.md"));
    }
  };
  if (scope) {
    // A `<prefix>:<name>` skill is either directory-scoped or a plugin's; both spellings look identical.
    addCandidates(path.join(cwd, scope));
    candidates.push(path.join(cwd, ".claude/plugins", scope, "skills", name, "SKILL.md"));
  }
  addCandidates(cwd);
  addCandidates(os.homedir());
  return candidates.find((candidate) => existsSync(candidate));
}

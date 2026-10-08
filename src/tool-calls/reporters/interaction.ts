import type {
  AskUserQuestionInput,
  AskUserQuestionOutput,
  ReportFindingsInput,
  TaskCreateInput,
  TaskUpdateInput,
  TodoWriteInput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { resultText, structuredResult, textContent } from "../content.js";
import type { ToolReporter, ToolResultContext, ToolResultFacts, ToolUseFacts } from "../facts.js";

/**
 * ExitPlanMode: the plan is input that the user approves.
 *
 * Claude writes the plan to a file under `plansDirectory` while it drafts it,
 * and the CLI adds the file text as `plan` to the complete input. The report
 * shows the plan text.
 */
export class ExitPlanModeReporter implements ToolReporter {
  toolUse(input: unknown): ToolUseFacts {
    const plan = (input as { plan?: string } | undefined)?.plan;
    return {
      title: "Approve Plan",
      kind: "switch_mode",
      ...(plan ? { display: [textContent(plan)] } : {}),
    };
  }

  /** The approval text repeats the plan, which the input holds. */
  toolResult(): ToolResultFacts {
    return { title: "Exited Plan Mode", rawOutput: undefined };
  }
}

/** AskUserQuestion: the questions are input that the user reads. */
export class AskUserQuestionReporter implements ToolReporter {
  /**
   * The question of a single-question ask labels the card. A multi-question
   * ask gets a fixed title.
   */
  toolUse(input: unknown): ToolUseFacts {
    const ask = input as Partial<AskUserQuestionInput> | undefined;
    const questions = Array.isArray(ask?.questions) ? ask.questions : [];
    const display = questions
      .filter((q) => typeof q?.question === "string")
      .map((q) => textContent(q.question));
    const single =
      questions.length === 1 && questions[0]?.question ? questions[0].question : undefined;
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
 * An agent control tool (SendMessage, TaskStop, ListAgents, Monitor). The
 * result text is the result to show, with the upstream fence.
 */
export class AgentControlReporter extends GenericReporter {
  constructor(private readonly controlToolName: string) {
    super(controlToolName);
  }

  toolUse(input: unknown): ToolUseFacts {
    // Fork: SendMessage's `summary` labels the card (the generic reporter
    // would show the bare tool name) and its `message` is input the user
    // reads — the same display copy Agent/Task gives the subagent prompt.
    if (this.controlToolName !== "SendMessage") return super.toolUse(input);
    const send = input as { summary?: unknown; message?: unknown } | undefined;
    return {
      title:
        typeof send?.summary === "string" && send.summary.length > 0 ? send.summary : "SendMessage",
      kind: "other",
      ...(typeof send?.message === "string" && send.message.length > 0
        ? { display: [textContent(send.message)] }
        : {}),
    };
  }
}

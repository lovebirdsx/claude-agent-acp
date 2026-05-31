/**
 * Pure projections for the interactive `AskUserQuestion` built-in tool.
 *
 * `AskUserQuestion` is exempt from the SDK's `permissionMode` auto-approval and
 * always reaches `canUseTool`. Unlike a permission gate it needs the user's
 * *answers* fed back to the model. ACP's `requestPermission` can only return a
 * single `optionId`, so we transport the questions/answers over an ACP
 * extension method (`extMethod`) instead and re-inject the answers via the
 * SDK's `canUseTool` → `updatedInput` contract (the built-in tool echoes the
 * `answers` field as its result). See the reference flow in
 * `claudeCanUseTool.ts:handleAskUserQuestion` of the host editor.
 */

/** ACP extension method name carrying the AskUserQuestion round-trip. */
export const ASK_USER_QUESTION_METHOD = "universe-editor/ask_user_question";

/** Narrowed view of the AskUserQuestion SDK input (no schema validation — the SDK is upstream). */
export interface ParsedAskUserQuestionInput {
  readonly questions: ReadonlyArray<{
    readonly question: string;
    readonly header: string;
    readonly options: ReadonlyArray<{
      readonly label: string;
      readonly description?: string;
      readonly preview?: string;
    }>;
    readonly multiSelect?: boolean;
  }>;
}

/**
 * Shape returned by the client over `extMethod`. The client owns the UI state
 * (selected labels, free-form input, notes) and returns the already-flattened
 * `answers` keyed by question text, matching the AskUserQuestion output
 * contract (`Record<questionText, comma-joined value>`).
 */
export interface AskUserQuestionResult {
  readonly cancelled?: boolean;
  readonly answers?: Record<string, string>;
  readonly annotations?: Record<string, { preview?: string; notes?: string }>;
}

/**
 * Cast the SDK input into the typed shape. Returns `undefined` when there are
 * no questions — the agent translates that into a `deny` PermissionResult.
 */
export function parseAskUserQuestionInput(
  input: Record<string, unknown>,
): ParsedAskUserQuestionInput | undefined {
  const ask = input as Partial<ParsedAskUserQuestionInput>;
  if (!ask.questions?.length) {
    return undefined;
  }
  return { questions: ask.questions };
}

/**
 * Normalize the client's `extMethod` response into the `{ answers, annotations }`
 * that gets spread into `updatedInput`. Returns `undefined` when the user
 * cancelled or answered nothing (callers `deny` in that case). Empty-string
 * answers are dropped; annotations with no preview/notes are dropped.
 */
export function normalizeAskUserQuestionResult(result: AskUserQuestionResult | undefined):
  | {
      answers: Record<string, string>;
      annotations?: Record<string, { preview?: string; notes?: string }>;
    }
  | undefined {
  if (!result || result.cancelled === true) {
    return undefined;
  }
  const answers: Record<string, string> = {};
  for (const [question, value] of Object.entries(result.answers ?? {})) {
    if (typeof value === "string" && value.length > 0) {
      answers[question] = value;
    }
  }
  if (Object.keys(answers).length === 0) {
    return undefined;
  }
  const annotations: Record<string, { preview?: string; notes?: string }> = {};
  for (const [question, ann] of Object.entries(result.annotations ?? {})) {
    if (!ann) continue;
    const entry: { preview?: string; notes?: string } = {};
    if (typeof ann.preview === "string" && ann.preview.length > 0) entry.preview = ann.preview;
    if (typeof ann.notes === "string" && ann.notes.length > 0) entry.notes = ann.notes;
    if (Object.keys(entry).length > 0) annotations[question] = entry;
  }
  return Object.keys(annotations).length > 0 ? { answers, annotations } : { answers };
}

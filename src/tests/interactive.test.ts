import { describe, it, expect } from "vitest";
import {
  ASK_USER_QUESTION_METHOD,
  normalizeAskUserQuestionResult,
  parseAskUserQuestionInput,
} from "../interactive.js";

describe("interactive / AskUserQuestion projections", () => {
  it("exposes a namespaced extension method name", () => {
    expect(ASK_USER_QUESTION_METHOD).toBe("universe-editor/ask_user_question");
  });

  describe("parseAskUserQuestionInput", () => {
    it("returns undefined when there are no questions", () => {
      expect(parseAskUserQuestionInput({})).toBeUndefined();
      expect(parseAskUserQuestionInput({ questions: [] })).toBeUndefined();
    });

    it("passes questions through", () => {
      const parsed = parseAskUserQuestionInput({
        questions: [
          { question: "Pick one?", header: "Pick", options: [{ label: "A" }], multiSelect: false },
        ],
      });
      expect(parsed?.questions).toHaveLength(1);
      expect(parsed?.questions[0]?.question).toBe("Pick one?");
    });
  });

  describe("normalizeAskUserQuestionResult", () => {
    it("returns undefined for cancellation / empty answers", () => {
      expect(normalizeAskUserQuestionResult(undefined)).toBeUndefined();
      expect(normalizeAskUserQuestionResult({ cancelled: true })).toBeUndefined();
      expect(normalizeAskUserQuestionResult({ answers: {} })).toBeUndefined();
      expect(normalizeAskUserQuestionResult({ answers: { "Q?": "" } })).toBeUndefined();
    });

    it("keeps non-empty answers and drops blank ones", () => {
      const out = normalizeAskUserQuestionResult({
        answers: { "Q1?": "A", "Q2?": "", "Q3?": "B, C" },
      });
      expect(out?.answers).toEqual({ "Q1?": "A", "Q3?": "B, C" });
      expect(out?.annotations).toBeUndefined();
    });

    it("carries through non-empty annotations only", () => {
      const out = normalizeAskUserQuestionResult({
        answers: { "Q1?": "A" },
        annotations: {
          "Q1?": { preview: "code", notes: "" },
          "Q2?": { preview: "", notes: "" },
        },
      });
      expect(out?.answers).toEqual({ "Q1?": "A" });
      expect(out?.annotations).toEqual({ "Q1?": { preview: "code" } });
    });
  });
});

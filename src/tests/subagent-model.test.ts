import { describe, it, expect, vi, afterEach } from "vitest";
import type { SettingsManager } from "../settings.js";
import { resolveSessionModel, resolveSubagentModelEnv } from "../subagent-model.js";

function settingsManagerWithModel(model: string | undefined): SettingsManager {
  return { getSettings: () => ({ model }) } as unknown as SettingsManager;
}

describe("resolveSessionModel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers ANTHROPIC_MODEL over the settings file", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-4-6");
    expect(resolveSessionModel(settingsManagerWithModel("kimi-k3[1m]"))).toBe("claude-sonnet-4-6");
  });

  it("falls back to the settings file model", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "");
    expect(resolveSessionModel(settingsManagerWithModel("kimi-k3[1m]"))).toBe("kimi-k3[1m]");
  });

  it("returns undefined when neither source has a model", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "");
    expect(resolveSessionModel(settingsManagerWithModel(undefined))).toBeUndefined();
  });
});

describe("resolveSubagentModelEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pins CLAUDE_CODE_SUBAGENT_MODEL to the session model", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "kimi-k3[1m]");
    expect(resolveSubagentModelEnv(settingsManagerWithModel(undefined))).toEqual({
      CLAUDE_CODE_SUBAGENT_MODEL: "kimi-k3[1m]",
    });
  });

  it("returns undefined when the host env already sets the var", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "kimi-k3[1m]");
    vi.stubEnv("CLAUDE_CODE_SUBAGENT_MODEL", "claude-sonnet-4-6");
    expect(resolveSubagentModelEnv(settingsManagerWithModel(undefined))).toBeUndefined();
  });

  it("returns undefined when the caller's env already sets the var", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "kimi-k3[1m]");
    expect(
      resolveSubagentModelEnv(settingsManagerWithModel(undefined), {
        CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-4-6",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when no session model can be resolved", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "");
    expect(resolveSubagentModelEnv(settingsManagerWithModel(undefined))).toBeUndefined();
  });
});

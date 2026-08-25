import { describe, it, expect, vi } from "vitest";
import type { ModelInfo, Query } from "@anthropic-ai/claude-agent-sdk";
import type { SettingsManager } from "../settings.js";
import {
  applyAvailableModelsAllowlist,
  buildConfigOptions,
  computeSessionFingerprint,
  getAvailableModels,
} from "../acp-agent.js";
import { appendExtraModelInfos, readExtraModelsMeta } from "../extra-models.js";

function info(value: string, displayName = value): ModelInfo {
  return { value, displayName, description: "sdk" } as ModelInfo;
}

describe("computeSessionFingerprint", () => {
  const base = { cwd: "/repo", mcpServers: [{ name: "srv-a", command: "a", args: [] }] };

  it("changes when extraModels differ", () => {
    // Regression: the fingerprint used to ignore _meta, so a second
    // session/load with new extras hit the cached fingerprint and returned the
    // stale configOptions — the newly injected gateway models never appeared.
    const a = computeSessionFingerprint({ ...base, _meta: { extraModels: ["kimi-k3"] } });
    const b = computeSessionFingerprint({
      ...base,
      _meta: { extraModels: ["deepseek-pro-v4"] },
    });
    expect(a).not.toBe(b);
  });

  it("is stable for identical inputs", () => {
    const a = computeSessionFingerprint({ ...base, _meta: { extraModels: ["kimi-k3"] } });
    const b = computeSessionFingerprint({ ...base, _meta: { extraModels: ["kimi-k3"] } });
    expect(a).toBe(b);
  });

  it("treats a missing _meta and an empty extras list as the same 'no extras' state", () => {
    const a = computeSessionFingerprint(base);
    const b = computeSessionFingerprint({ ...base, _meta: { extraModels: [] } });
    expect(a).toBe(b);
  });
});

describe("readExtraModelsMeta", () => {
  it("reads a top-level string array", () => {
    expect(readExtraModelsMeta({ extraModels: ["a", "b"] })).toEqual(["a", "b"]);
  });

  it("trims, drops blanks, and dedupes", () => {
    expect(readExtraModelsMeta({ extraModels: [" a ", "", "  ", "a", "b"] })).toEqual(["a", "b"]);
  });

  it("skips non-string entries instead of failing", () => {
    expect(readExtraModelsMeta({ extraModels: ["a", 42, null, { x: 1 }, "b"] })).toEqual(["a", "b"]);
  });

  it("keeps a context-lane suffix verbatim", () => {
    expect(readExtraModelsMeta({ extraModels: ["kimi-k3[1m]"] })).toEqual(["kimi-k3[1m]"]);
  });

  it("caps the payload at 64 entries", () => {
    const many = Array.from({ length: 100 }, (_, i) => `m${i}`);
    expect(readExtraModelsMeta({ extraModels: many })?.length).toBe(64);
  });

  it("returns undefined for absent / malformed / all-empty payloads", () => {
    expect(readExtraModelsMeta(undefined)).toBeUndefined();
    expect(readExtraModelsMeta({})).toBeUndefined();
    expect(readExtraModelsMeta({ extraModels: "nope" })).toBeUndefined();
    expect(readExtraModelsMeta({ extraModels: [] })).toBeUndefined();
    expect(readExtraModelsMeta({ extraModels: [123] })).toBeUndefined();
  });
});

describe("appendExtraModelInfos", () => {
  it("appends a synthesized entry per unknown id", () => {
    const out = appendExtraModelInfos([info("default", "Default")], ["deepseek-pro-v4"]);
    expect(out.map((m) => m.value)).toEqual(["default", "deepseek-pro-v4"]);
    expect(out[1]).toEqual({
      value: "deepseek-pro-v4",
      displayName: "deepseek-pro-v4",
      description: "",
    });
  });

  it("keeps SDK metadata for ids the catalogue already has", () => {
    const out = appendExtraModelInfos([info("sonnet", "Sonnet")], ["sonnet"]);
    expect(out).toHaveLength(1);
    expect(out[0]!.displayName).toBe("Sonnet");
  });

  it("dedupes repeated extras", () => {
    const out = appendExtraModelInfos([], ["a", "a"]);
    expect(out.map((m) => m.value)).toEqual(["a"]);
  });

  it("returns the input untouched when there are no extras", () => {
    const existing = [info("sonnet")];
    expect(appendExtraModelInfos(existing, [])).toBe(existing);
  });

  it("does not mutate the input array", () => {
    const existing = [info("sonnet")];
    appendExtraModelInfos(existing, ["extra"]);
    expect(existing).toHaveLength(1);
  });

  it("carries the [1m] lane verbatim — never canonicalized to the bare id", () => {
    const out = appendExtraModelInfos([info("kimi-k3")], ["kimi-k3[1m]"]);
    expect(out.map((m) => m.value)).toEqual(["kimi-k3", "kimi-k3[1m]"]);
  });
});

/**
 * The whole point of the extension: an id the client injected must survive all
 * the way to the picker's `options` AND to `setSessionConfigOption`'s validation,
 * without the settings allowlist filtering it out.
 */
describe("extras reach the picker (createSession's model pipeline)", () => {
  const silentLogger = { log: () => {}, error: () => {} };
  const sdkModels: ModelInfo[] = [info("default", "Default"), info("claude-sonnet-4-6", "Sonnet")];

  function settings(s: Record<string, unknown> = {}): SettingsManager {
    return { getSettings: () => s } as unknown as SettingsManager;
  }

  /** Mirrors createSession: filter by allowlist, then append the client's extras. */
  function resolveAllowed(meta: unknown, availableModels?: string[]): ModelInfo[] {
    const allowlisted = Array.isArray(availableModels)
      ? applyAvailableModelsAllowlist(sdkModels, availableModels)
      : sdkModels;
    return appendExtraModelInfos(allowlisted, readExtraModelsMeta(meta) ?? []);
  }

  async function pickerOptions(allowed: ModelInfo[], settingsModel?: string) {
    const query = { getContextUsage: vi.fn(), setModel: vi.fn() } as unknown as Query;
    const { state } = await getAvailableModels(
      query,
      allowed,
      sdkModels,
      settings(settingsModel !== undefined ? { model: settingsModel } : {}),
      silentLogger,
      false,
    );
    const options = buildConfigOptions(
      { currentModeId: "default", availableModes: [] },
      state,
      allowed,
    );
    const model = options.find((o) => o.id === "model");
    return {
      currentValue: model?.currentValue,
      values: model?.type === "select" ? model.options.map((o) => "value" in o && o.value) : [],
    };
  }

  it("surfaces an injected gateway model in the model picker", async () => {
    const allowed = resolveAllowed({ extraModels: ["deepseek-pro-v4"] });
    const { values } = await pickerOptions(allowed);
    expect(values).toContain("deepseek-pro-v4");
  });

  it("exempts extras from the settings availableModels allowlist", async () => {
    // The allowlist alone would leave only Default + sonnet.
    const allowed = resolveAllowed(
      { extraModels: ["deepseek-pro-v4"] },
      ["claude-sonnet-4-6"],
    );
    const { values } = await pickerOptions(allowed);
    expect(values).toContain("deepseek-pro-v4");
    expect(values).toContain("claude-sonnet-4-6");
  });

  it("resolves settings.model onto an injected id with its lane intact", async () => {
    const allowed = resolveAllowed({ extraModels: ["deepseek-pro-v4[1m]", "deepseek-pro-v4"] });
    const { currentValue, values } = await pickerOptions(allowed, "deepseek-pro-v4[1m]");
    // Exact match must win over the fuzzy tokenized fallback, which would land
    // on the bare entry and silently clamp the context window back to 200k.
    expect(currentValue).toBe("deepseek-pro-v4[1m]");
    expect(values).toContain("deepseek-pro-v4[1m]");
  });

  it("leaves the picker untouched when no extras are injected", async () => {
    const allowed = resolveAllowed(undefined);
    expect(allowed).toBe(sdkModels);
  });
});

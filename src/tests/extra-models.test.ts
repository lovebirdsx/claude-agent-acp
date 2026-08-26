import { describe, it, expect, vi } from "vitest";
import type { ModelInfo, Query } from "@anthropic-ai/claude-agent-sdk";
import type { SettingsManager } from "../settings.js";
import {
  applyAvailableModelsAllowlist,
  buildConfigOptions,
  computeSessionFingerprint,
  getAvailableModels,
} from "../acp-agent.js";
import {
  appendExtraModelInfos,
  readExtraModelEffortMeta,
  readExtraModelsMeta,
} from "../extra-models.js";

function info(value: string, displayName = value): ModelInfo {
  return { value, displayName, description: "sdk" } as ModelInfo;
}

describe("computeSessionFingerprint", () => {
  const base = { cwd: "/repo", mcpServers: [{ name: "srv-a", command: "a", args: [], env: [] }] };

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

  it("changes when extraModelEffort differs for the same extraModels", () => {
    const a = computeSessionFingerprint({
      ...base,
      _meta: {
        extraModels: ["deepseek-pro-v4"],
        extraModelEffort: [{ id: "deepseek-pro-v4", effortLevels: ["low"] }],
      },
    });
    const b = computeSessionFingerprint({
      ...base,
      _meta: {
        extraModels: ["deepseek-pro-v4"],
        extraModelEffort: [{ id: "deepseek-pro-v4", effortLevels: ["high"] }],
      },
    });
    expect(a).not.toBe(b);
  });

  it("is stable when extraModelEffort levels are declared in a different order", () => {
    const a = computeSessionFingerprint({
      ...base,
      _meta: {
        extraModels: ["m"],
        extraModelEffort: [{ id: "m", effortLevels: ["low", "high"] }],
      },
    });
    const b = computeSessionFingerprint({
      ...base,
      _meta: {
        extraModels: ["m"],
        extraModelEffort: [{ id: "m", effortLevels: ["high", "low"] }],
      },
    });
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

describe("readExtraModelEffortMeta", () => {
  it("reads an array of { id, effortLevels } entries", () => {
    expect(
      readExtraModelEffortMeta({
        extraModelEffort: [
          { id: "deepseek-pro-v4", effortLevels: ["low", "max"] },
          { id: "kimi-k3", effortLevels: ["high"] },
        ],
      }),
    ).toEqual(
      new Map([
        ["deepseek-pro-v4", ["low", "max"]],
        ["kimi-k3", ["high"]],
      ]),
    );
  });

  it("trims the id, drops blanks, and keeps the first id on duplicate", () => {
    const out = readExtraModelEffortMeta({
      extraModelEffort: [
        { id: " deepseek-pro-v4 ", effortLevels: ["low"] },
        { id: "deepseek-pro-v4", effortLevels: ["high"] },
        { id: " ", effortLevels: ["max"] },
      ],
    });
    expect(out).toEqual(new Map([["deepseek-pro-v4", ["low"]]]));
  });

  it("collects only trimmed non-empty string levels", () => {
    expect(
      readExtraModelEffortMeta({
        extraModelEffort: [{ id: "m", effortLevels: [" low ", "", "  ", 42, null, "max"] }],
      }),
    ).toEqual(new Map([["m", ["low", "max"]]]));
  });

  it("caps the payload at 64 entries", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      id: `m${i}`,
      effortLevels: ["low"],
    }));
    expect(readExtraModelEffortMeta({ extraModelEffort: many }).size).toBe(64);
  });

  it("returns an empty map for absent / malformed payloads", () => {
    expect(readExtraModelEffortMeta(undefined)).toEqual(new Map());
    expect(readExtraModelEffortMeta({})).toEqual(new Map());
    expect(readExtraModelEffortMeta({ extraModelEffort: "nope" })).toEqual(new Map());
    expect(readExtraModelEffortMeta({ extraModelEffort: [] })).toEqual(new Map());
    expect(readExtraModelEffortMeta({ extraModelEffort: [42] })).toEqual(new Map());
    expect(
      readExtraModelEffortMeta({ extraModelEffort: [{ id: "m", effortLevels: "nope" }] }),
    ).toEqual(new Map());
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

  it("attaches effort to an id the catalogue already has, keeping its SDK metadata", () => {
    const out = appendExtraModelInfos(
      [info("sonnet", "Sonnet")],
      ["sonnet"],
      new Map([["sonnet", ["low", "high"]]]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      value: "sonnet",
      displayName: "Sonnet",
      description: "sdk",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
    });
  });

  it("does not overwrite an existing effort declaration on an id the catalogue has", () => {
    const entry = {
      value: "sonnet",
      displayName: "Sonnet",
      description: "sdk",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium"],
    } as unknown as ModelInfo;
    const out = appendExtraModelInfos([entry], ["sonnet"], new Map([["sonnet", ["high"]]]));
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(entry);
  });

  it("does not turn an explicit supportsEffort:false into true", () => {
    const entry = {
      value: "sonnet",
      displayName: "Sonnet",
      description: "sdk",
      supportsEffort: false,
    } as unknown as ModelInfo;
    const out = appendExtraModelInfos([entry], ["sonnet"], new Map([["sonnet", ["low"]]]));
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(entry);
    expect(out[0]!.supportsEffort).toBe(false);
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

  it("fills effort capability when the id hits the effort table", () => {
    const out = appendExtraModelInfos([], ["deepseek-pro-v4"], new Map([["deepseek-pro-v4", ["low", "max"]]]));
    expect(out[0]).toEqual({
      value: "deepseek-pro-v4",
      displayName: "deepseek-pro-v4",
      description: "",
      supportsEffort: true,
      supportedEffortLevels: ["low", "max"],
    });
  });

  it("narrows levels to the SDK's legal enum and drops the rest", () => {
    const out = appendExtraModelInfos(
      [],
      ["m"],
      new Map([["m", ["low", "minimal", "max", "", "  "]]]),
    );
    expect(out[0]!.supportedEffortLevels).toEqual(["low", "max"]);
  });

  it("keeps a bare entry when the id misses the effort table or has no legal levels", () => {
    expect(appendExtraModelInfos([], ["m"])[0]).toEqual({
      value: "m",
      displayName: "m",
      description: "",
    });
    const filteredEmpty = appendExtraModelInfos([], ["m"], new Map([["m", ["minimal"]]]));
    expect(filteredEmpty[0]).toEqual({ value: "m", displayName: "m", description: "" });
    expect("supportsEffort" in filteredEmpty[0]!).toBe(false);
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

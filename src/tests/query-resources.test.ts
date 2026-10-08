import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseQueryResources, type QueryResourceHolder } from "../query-resources.js";

afterEach(() => vi.restoreAllMocks());

type Harness = {
  session: QueryResourceHolder;
  calls: { settings: number; input: number; query: number };
  order: string[];
  timer: ReturnType<typeof setTimeout>;
};

function harness(withTimer = true): Harness {
  const calls = { settings: 0, input: 0, query: 0 };
  const order: string[] = [];
  const timer = setTimeout(() => {}, 60_000);
  const session: QueryResourceHolder = {
    queryClosed: false,
    consumer: Promise.resolve(),
    contextCompaction: {},
    ...(withTimer ? { orphanQueuedTurnTimer: timer } : {}),
    settingsManager: {
      dispose: () => {
        calls.settings += 1;
        order.push("settings");
      },
    },
    input: {
      end: () => {
        calls.input += 1;
        order.push("input");
      },
    },
    query: {
      close: () => {
        calls.query += 1;
        order.push("query");
      },
    },
  };
  return { session, calls, order, timer };
}

describe("releaseQueryResources", () => {
  it("按 settings dispose → input.end → query.close 顺序释放，并置 queryClosed", () => {
    const { session, calls, order } = harness();
    releaseQueryResources(session);
    expect(order).toEqual(["settings", "input", "query"]);
    expect(calls).toEqual({ settings: 1, input: 1, query: 1 });
    expect(session.queryClosed).toBe(true);
  });

  it("清空 consumer 与 compaction 句柄", () => {
    const { session } = harness();
    releaseQueryResources(session);
    expect(session.consumer).toBeUndefined();
    expect(session.contextCompaction).toBeUndefined();
  });

  it("清掉孤儿 queued-turn 计时器并置空字段", () => {
    const { session, timer } = harness();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    releaseQueryResources(session);
    expect(clearSpy).toHaveBeenCalledWith(timer);
    expect(session.orphanQueuedTurnTimer).toBeUndefined();
  });

  it("没有计时器时不调用 clearTimeout", () => {
    const { session } = harness(false);
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    releaseQueryResources(session);
    expect(clearSpy).not.toHaveBeenCalled();
    expect(session.orphanQueuedTurnTimer).toBeUndefined();
  });

  it("幂等：重复释放不重复 dispose/end/close", () => {
    const { session, calls } = harness();
    releaseQueryResources(session);
    releaseQueryResources(session);
    expect(calls).toEqual({ settings: 1, input: 1, query: 1 });
  });
});

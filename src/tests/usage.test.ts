import { describe, it, expect, vi } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { readSubscriptionUsage } from "../usage.js";

const USAGE_METHOD_NAME = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";

function mockLogger() {
  const error = vi.fn<(...args: any[]) => void>();
  return { logger: { error }, error };
}

function queryWith(usage: unknown): Query {
  return { [USAGE_METHOD_NAME]: vi.fn().mockResolvedValue(usage) } as unknown as Query;
}

describe("readSubscriptionUsage", () => {
  it("passes the plan's rate-limit windows through untouched for the editor to normalize", async () => {
    const rateLimits = {
      five_hour: { utilization: 42, resets_at: "2026-08-22T12:00:00.000Z" },
      seven_day: { utilization: 71, resets_at: null },
    };
    const { logger, error } = mockLogger();

    const response = await readSubscriptionUsage(
      queryWith({ subscription_type: "max", rate_limits_available: true, rate_limits: rateLimits }),
      logger,
    );

    expect(response).toEqual({
      vendor: "claude",
      supported: true,
      subscriptionType: "max",
      rateLimitsAvailable: true,
      rateLimits,
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("reports an API-key session as a subscription-less one rather than an error", async () => {
    // `subscription_type: null` is a normal value: the session bills per token,
    // so the editor falls back to the gateway spend readout.
    const { logger, error } = mockLogger();

    const response = await readSubscriptionUsage(
      queryWith({ subscription_type: null, rate_limits_available: false, rate_limits: null }),
      logger,
    );

    expect(response.supported).toBe(true);
    expect(response.rateLimitsAvailable).toBe(false);
    expect(response.subscriptionType).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it("degrades when the SDK does not expose the experimental usage method", async () => {
    const { logger, error } = mockLogger();

    const response = await readSubscriptionUsage({} as unknown as Query, logger);

    expect(response.supported).toBe(false);
    expect(response.rateLimits).toBeNull();
    expect(error).toHaveBeenCalledOnce();
  });

  it("degrades when the usage call throws", async () => {
    const { logger, error } = mockLogger();
    const query = {
      [USAGE_METHOD_NAME]: vi.fn().mockRejectedValue(new Error("control request failed")),
    } as unknown as Query;

    const response = await readSubscriptionUsage(query, logger);

    expect(response).toEqual({
      vendor: "claude",
      supported: false,
      subscriptionType: null,
      rateLimitsAvailable: false,
      rateLimits: null,
    });
    expect(error).toHaveBeenCalledOnce();
  });
});

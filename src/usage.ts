/**
 * Official-subscription usage readout (the claude.ai plan's rate-limit windows)
 * for the editor's usage indicator.
 *
 * This lives in its own file rather than `acp-agent.ts` because the SDK entry
 * point it builds on is explicitly experimental:
 * `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`, the same
 * call that backs the CLI's `/usage` dialog. Isolating it keeps an upstream
 * rename/removal a one-file fix and keeps the fork's diff against upstream
 * confined to the registration in `acp-agent.ts`.
 */

import type { Query, SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";

/** ACP extension method name carrying the subscription usage snapshot. */
export const SUBSCRIPTION_USAGE_METHOD = "universe-editor/subscription_usage";

/** The experimental SDK method, referenced by name so we can probe for it at runtime. */
const USAGE_METHOD_NAME = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";

/** Minimal logger shape; declared locally so this file has no cycle with `acp-agent.ts`. */
interface UsageLogger {
  error: (...args: any[]) => void;
}

export interface SubscriptionUsageRequest {
  sessionId: string;
}

/**
 * Vendor-native payload; the editor owns normalization so the claude and codex
 * forks cannot drift apart.
 *
 * `supported: false` means no snapshot could be read at all (the SDK no longer
 * exposes the call, or the control request failed). That is distinct from a
 * snapshot that reads fine but reports no plan limits
 * (`rateLimitsAvailable: false`, i.e. API key / Bedrock / Vertex sessions) —
 * a normal outcome the editor turns into its gateway-spend fallback.
 */
export interface SubscriptionUsageResponse {
  vendor: "claude";
  supported: boolean;
  /** 'pro' | 'max' | 'team' | 'enterprise', or null for API key / 3P provider sessions. */
  subscriptionType: string | null;
  rateLimitsAvailable: boolean;
  rateLimits: SDKControlGetUsageResponse["rate_limits"];
}

function unsupported(): SubscriptionUsageResponse {
  return {
    vendor: "claude",
    supported: false,
    subscriptionType: null,
    rateLimitsAvailable: false,
    rateLimits: null,
  };
}

export async function readSubscriptionUsage(
  query: Query,
  logger: UsageLogger,
): Promise<SubscriptionUsageResponse> {
  // Probe at runtime instead of calling the method statically: its own name
  // says the API may change, so an SDK bump that renames or drops it has to
  // degrade into "no snapshot" rather than break the session.
  const probe = (query as unknown as Record<string, unknown>)[USAGE_METHOD_NAME];
  if (typeof probe !== "function") {
    logger.error(`Subscription usage unavailable: SDK has no ${USAGE_METHOD_NAME}()`);
    return unsupported();
  }
  try {
    const read = probe as () => Promise<SDKControlGetUsageResponse>;
    const usage = await read.call(query);
    return {
      vendor: "claude",
      supported: true,
      // null here is a normal value (API key / 3P provider session), not a failure.
      subscriptionType: usage.subscription_type ?? null,
      rateLimitsAvailable: usage.rate_limits_available === true,
      rateLimits: usage.rate_limits ?? null,
    };
  } catch (error) {
    logger.error("Failed to read the subscription usage snapshot:", error);
    return unsupported();
  }
}

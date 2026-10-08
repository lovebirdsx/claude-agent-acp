import {
  type SDKAssistantMessageError,
  USAGE_LIMIT_ERROR_PREFIXES,
} from "@anthropic-ai/claude-agent-sdk";

/** The categorical reason a Claude turn failed, derived from the SDK's error
 *  classification, the synthetic usage-limit text, or the adapter's own
 *  stream/transport state. */
export type ClaudeFailureKind =
  | "access_denied"
  | "advisory"
  | "auth_required"
  | "bad_request"
  | "budget_exhausted"
  | "context_exhausted"
  | "internal_error"
  | "overloaded"
  | "provider_error"
  | "quota_exhausted"
  | "rate_limited"
  | "transport_lost"
  | "worker_shutdown";

/** `getSessionMessages` deliberately exposes only the API message and strips
 *  transcript-level `error` / `isApiErrorMessage` fields. The SDK exports the
 *  exact stable prefixes used by its synthetic usage-limit errors, so replay
 *  can recover this one typed failure without matching arbitrary model prose. */
export function assistantMessageText(apiMessage: unknown): string | undefined {
  if (!apiMessage || typeof apiMessage !== "object") return undefined;
  const { content } = apiMessage as { content?: unknown };
  if (typeof content === "string") return content || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) =>
      block &&
      typeof block === "object" &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("");
  return text || undefined;
}

export function isSyntheticUsageLimitMessage(apiMessage: unknown): boolean {
  if (!apiMessage || typeof apiMessage !== "object") return false;
  const { model } = apiMessage as { model?: unknown };
  if (model !== "<synthetic>") return false;
  const text = assistantMessageText(apiMessage);
  if (!text) return false;
  return USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => text.startsWith(prefix));
}

export function providerFailureCategory(
  errorKind?: SDKAssistantMessageError,
  isUsageLimit = false,
): ClaudeFailureKind {
  if (isUsageLimit) return "quota_exhausted";
  switch (errorKind) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
      return "auth_required";
    case "billing_error":
    case "account_on_hold":
      return "quota_exhausted";
    // 403 `permission_error` with error_code `verification_required` (the
    // organization must verify at the console), and a Bedrock/Vertex/Foundry
    // credential the CLI could not load (transient: it retries, and asks the
    // user to check or refresh the credentials). Both are access failures
    // `/login` does not repair, so they get their own lane rather than
    // `auth_required`'s login action and sticky auth_status recovery.
    case "verification_required":
    case "cloud_credential_error":
      return "access_denied";
    case "rate_limit":
      return "rate_limited";
    case "overloaded":
      return "overloaded";
    case "invalid_request":
    case "model_not_found":
      return "bad_request";
    case "max_output_tokens":
      return "context_exhausted";
    case "server_error":
    case "unknown":
    case undefined:
      return "provider_error";
    default:
      return "provider_error";
  }
}

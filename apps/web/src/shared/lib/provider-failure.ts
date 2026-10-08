// Provider failure classification, copied from Pace's
// packages/core/src/provider-auth.ts (commit 15b9084) — just the functions
// chat-run-failure needs, not the Settings-facing status surface.
export type ProviderFailureKind = "auth" | "entitlement" | "network" | "unknown";

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

type ProviderFailureDetail = {
  status?: number;
  networkCode?: string;
  message: string;
};

function ownMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

/**
 * pi-ai folds SDK errors into `errorMessage` and only keeps a numeric status
 * when `formatProviderError` prefixes it. The fields below are the ones
 * `normalizeProviderError` reads before that formatting, in the same order
 * (`error-body.js` `extractStatus`): Mistral `statusCode`, OpenAI / Google
 * `status`, Bedrock `$metadata.httpStatusCode`, Bedrock `$response.statusCode`.
 * `fetch` puts the socket code on `error.cause`, so the walk follows `cause`.
 */
function inspectProviderFailure(error: unknown, depth = 0): ProviderFailureDetail {
  if (depth > 4) return { message: "" };

  const message = ownMessage(error);
  if (!error || typeof error !== "object") return { message };

  const record = error as Record<string, unknown>;
  const status = httpStatus(record);
  const code = typeof record.code === "string" && NETWORK_CODES.has(record.code) ? record.code : undefined;
  const cause = inspectProviderFailure(record.cause, depth + 1);
  const causeMessage = cause.message && !message.includes(cause.message) ? cause.message : "";

  return {
    status: status ?? cause.status,
    networkCode: code ?? cause.networkCode,
    message: [message, causeMessage].filter(Boolean).join(" "),
  };
}

function httpStatus(error: Record<string, unknown>): number | undefined {
  if (typeof error.statusCode === "number") return error.statusCode;
  if (typeof error.status === "number") return error.status;

  const metadata = error.$metadata;
  if (isRecord(metadata) && typeof metadata.httpStatusCode === "number") {
    return metadata.httpStatusCode;
  }

  const response = error.$response;
  if (isRecord(response) && typeof response.statusCode === "number") {
    return response.statusCode;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// pi-ai retries these as transport failures (`retry.js`, the network/proxy/fetch
// block of RETRYABLE_PROVIDER_ERROR_PATTERN). OpenAI and Anthropic SDKs also
// default APIConnectionError to "Connection error." and APIConnectionTimeoutError
// to "Request timed out."; formatProviderError keeps that message when the
// failure has no HTTP status, so completeSimple resolves stopReason "error"
// with this text instead of throwing.
const RESOLVED_NETWORK_MESSAGE =
  /network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?closed|websocket.?error|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|ECONNREFUSED|ETIMEDOUT|ECONNRESET|UND_ERR_/i;

// A dead OAuth refresh token comes back as HTTP 400 invalid_grant: the fix is
// signing in again, same as a 401.
const OAUTH_REFRESH_FAILURE = /invalid_grant|oauth refresh failed|refresh.?token/i;

function kindFromDetail(detail: ProviderFailureDetail): ProviderFailureKind {
  // Status wins over prose: a 401 that mentions a plan is still an auth failure,
  // and a 403 that says "unauthorized" is still an entitlement reject.
  if (detail.status === 401 || /\b401\b/.test(detail.message)) return "auth";
  if (detail.status === 403 || /\b403\b/.test(detail.message)) return "entitlement";
  if (/\b(?:plan|subscription|entitlement)\b/i.test(detail.message)) return "entitlement";
  // Network before auth prose: a refresh that never reached the provider
  // ("OAuth refresh failed ...: fetch failed") needs connectivity, not a new login.
  if (detail.networkCode || RESOLVED_NETWORK_MESSAGE.test(detail.message)) return "network";
  if (
    /invalid.?api.?key|authentication_error|unauthorized/i.test(detail.message) ||
    OAUTH_REFRESH_FAILURE.test(detail.message)
  ) {
    return "auth";
  }
  return "unknown";
}

export function classifyProviderFailure(error: unknown): ProviderFailureKind {
  return kindFromDetail(inspectProviderFailure(error));
}

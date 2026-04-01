import type { AdapterExecutionResult } from "./types.js";

// ---------------------------------------------------------------------------
// Error taxonomy categories
// ---------------------------------------------------------------------------

export type ErrorCategory = "retriable" | "fatal" | "actionable";

export type RetriableErrorCode =
  | "rate_limit"
  | "transient"
  | "timeout"
  | "server_error"
  | "process_lost";

export type FatalErrorCode =
  | "auth_failed"
  | "quota_exhausted"
  | "invalid_model"
  | "invalid_config"
  | "adapter_missing";

export type ActionableErrorCode =
  | "max_turns"
  | "permission_denied"
  | "context_overflow"
  | "content_policy";

export type TaxonomyErrorCode = RetriableErrorCode | FatalErrorCode | ActionableErrorCode;

export interface ErrorClassification {
  category: ErrorCategory;
  code: TaxonomyErrorCode;
  retriable: boolean;
  shouldPauseAgent: boolean;
  suggestedDelaySec: number | null;
  message: string;
}

// ---------------------------------------------------------------------------
// Pattern matchers (case-insensitive)
// ---------------------------------------------------------------------------

interface PatternEntry {
  pattern: RegExp;
  code: TaxonomyErrorCode;
  category: ErrorCategory;
}

const ERROR_PATTERNS: PatternEntry[] = [
  // Retriable — rate limits
  { pattern: /rate.?limit|429|too many requests|throttl/i, code: "rate_limit", category: "retriable" },
  { pattern: /overloaded|503|service unavailable|temporarily unavailable/i, code: "server_error", category: "retriable" },
  { pattern: /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|socket hang up/i, code: "transient", category: "retriable" },
  { pattern: /timeout|timed?.?out|deadline exceeded/i, code: "timeout", category: "retriable" },
  { pattern: /process.?lost/i, code: "process_lost", category: "retriable" },
  { pattern: /502|bad gateway/i, code: "server_error", category: "retriable" },
  { pattern: /500|internal server error/i, code: "server_error", category: "retriable" },

  // Fatal — auth & config
  { pattern: /401|unauthorized|invalid.?api.?key|authentication|invalid.?x-api-key/i, code: "auth_failed", category: "fatal" },
  { pattern: /403|forbidden|access.?denied/i, code: "auth_failed", category: "fatal" },
  { pattern: /quota|credit|billing|payment.?required|insufficient.?funds/i, code: "quota_exhausted", category: "fatal" },
  { pattern: /invalid.?model|model.?not.?found|does not exist/i, code: "invalid_model", category: "fatal" },
  { pattern: /invalid.?config|misconfigured|missing.?config/i, code: "invalid_config", category: "fatal" },
  { pattern: /adapter.?not.?found|adapter.?missing|unknown.?adapter/i, code: "adapter_missing", category: "fatal" },

  // Actionable — need human/agent action
  { pattern: /max.?turns|maximum.?turns|turn.?limit|max_turns_reached/i, code: "max_turns", category: "actionable" },
  { pattern: /permission.?denied|not.?allowed|requires.?permission/i, code: "permission_denied", category: "actionable" },
  { pattern: /context.?length|context.?window|token.?limit|too.?long/i, code: "context_overflow", category: "actionable" },
  { pattern: /content.?policy|safety|moderation|blocked.?by.?policy/i, code: "content_policy", category: "actionable" },
];

// ---------------------------------------------------------------------------
// Backoff configuration per category
// ---------------------------------------------------------------------------

const BACKOFF_BASE_SEC: Record<ErrorCategory, number | null> = {
  retriable: 30,
  fatal: null,
  actionable: null,
};

const BACKOFF_BY_CODE: Partial<Record<TaxonomyErrorCode, number>> = {
  rate_limit: 60,
  timeout: 15,
  transient: 10,
  server_error: 30,
  process_lost: 5,
};

const MAX_BACKOFF_SEC = 300;

/**
 * Compute retry delay with exponential backoff and jitter.
 * Returns null for non-retriable errors.
 */
export function computeRetryDelay(code: TaxonomyErrorCode, category: ErrorCategory, attempt: number): number | null {
  if (category !== "retriable") return null;
  const base = BACKOFF_BY_CODE[code] ?? BACKOFF_BASE_SEC.retriable ?? 30;
  const exponential = base * Math.pow(2, Math.min(attempt, 5));
  const jitter = exponential * 0.25 * Math.random();
  return Math.min(exponential + jitter, MAX_BACKOFF_SEC);
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify an adapter execution result into an error taxonomy category.
 * Returns null if the result represents success (no error).
 */
export function classifyAdapterError(result: AdapterExecutionResult, attempt?: number): ErrorClassification | null {
  const exitCode = result.exitCode ?? 0;
  const hasError = exitCode !== 0 || !!result.errorMessage || result.timedOut;
  if (!hasError) return null;

  // Check existing errorCode from adapter first
  if (result.errorCode) {
    for (const entry of ERROR_PATTERNS) {
      if (entry.pattern.test(result.errorCode)) {
        return buildClassification(entry.code, entry.category, result.errorMessage ?? result.errorCode, attempt ?? 0);
      }
    }
  }

  // Timeout (from adapter result flag)
  if (result.timedOut) {
    return buildClassification("timeout", "retriable", result.errorMessage ?? "Adapter execution timed out", attempt ?? 0);
  }

  // Match against error message patterns
  const message = result.errorMessage ?? "";
  for (const entry of ERROR_PATTERNS) {
    if (entry.pattern.test(message)) {
      return buildClassification(entry.code, entry.category, message, attempt ?? 0);
    }
  }

  // Check stderr/stdout in resultJson for additional signals
  const resultJson = result.errorMeta ?? result.resultJson ?? {};
  const stderr = typeof resultJson.stderr === "string" ? resultJson.stderr : "";
  const stdout = typeof resultJson.stdout === "string" ? resultJson.stdout : "";
  const combinedOutput = `${stderr}\n${stdout}`;

  for (const entry of ERROR_PATTERNS) {
    if (entry.pattern.test(combinedOutput)) {
      return buildClassification(entry.code, entry.category, message || `Detected ${entry.code} in adapter output`, attempt ?? 0);
    }
  }

  // Default: unclassified adapter failure → retriable (conservative)
  return buildClassification("transient", "retriable", message || `Adapter failed with exit code ${exitCode}`, attempt ?? 0);
}

function buildClassification(
  code: TaxonomyErrorCode,
  category: ErrorCategory,
  message: string,
  attempt: number,
): ErrorClassification {
  return {
    category,
    code,
    retriable: category === "retriable",
    shouldPauseAgent: category === "fatal",
    suggestedDelaySec: computeRetryDelay(code, category, attempt),
    message,
  };
}

/**
 * Returns a human-readable summary for the error classification.
 */
export function formatClassification(c: ErrorClassification): string {
  const action = c.retriable
    ? c.suggestedDelaySec
      ? `will retry in ~${Math.round(c.suggestedDelaySec)}s`
      : "will retry"
    : c.shouldPauseAgent
      ? "agent paused — requires attention"
      : "needs manual action";
  return `[${c.category}/${c.code}] ${c.message} (${action})`;
}

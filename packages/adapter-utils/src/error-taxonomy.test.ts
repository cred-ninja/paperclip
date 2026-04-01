import { describe, expect, it } from "vitest";
import {
  classifyAdapterError,
  computeRetryDelay,
  formatClassification,
  type ErrorClassification,
} from "./error-taxonomy.js";
import type { AdapterExecutionResult } from "./types.js";

// ---------------------------------------------------------------------------
// Helper to build minimal adapter results
// ---------------------------------------------------------------------------

function result(overrides: Partial<AdapterExecutionResult> = {}): AdapterExecutionResult {
  return {
    exitCode: 1,
    timedOut: false,
    errorMessage: "",
    ...overrides,
  } as AdapterExecutionResult;
}

// ---------------------------------------------------------------------------
// classifyAdapterError
// ---------------------------------------------------------------------------

describe("classifyAdapterError", () => {
  it("returns null for a successful result", () => {
    expect(classifyAdapterError(result({ exitCode: 0, errorMessage: undefined }))).toBeNull();
  });

  // -- Retriable errors ---------------------------------------------------

  it("classifies rate limit errors as retriable/rate_limit", () => {
    const c = classifyAdapterError(result({ errorMessage: "429 Too Many Requests" }))!;
    expect(c.category).toBe("retriable");
    expect(c.code).toBe("rate_limit");
    expect(c.retriable).toBe(true);
    expect(c.shouldPauseAgent).toBe(false);
  });

  it("classifies timeout via timedOut flag", () => {
    const c = classifyAdapterError(result({ timedOut: true, exitCode: 0 }))!;
    expect(c.category).toBe("retriable");
    expect(c.code).toBe("timeout");
    expect(c.retriable).toBe(true);
  });

  it("classifies ECONNRESET as retriable/transient", () => {
    const c = classifyAdapterError(result({ errorMessage: "ECONNRESET" }))!;
    expect(c.category).toBe("retriable");
    expect(c.code).toBe("transient");
  });

  it("classifies 503 as retriable/server_error", () => {
    const c = classifyAdapterError(result({ errorMessage: "503 Service Unavailable" }))!;
    expect(c.category).toBe("retriable");
    expect(c.code).toBe("server_error");
  });

  it("classifies 502 Bad Gateway as retriable/server_error", () => {
    const c = classifyAdapterError(result({ errorMessage: "502 Bad Gateway" }))!;
    expect(c.code).toBe("server_error");
  });

  it("classifies process_lost as retriable", () => {
    const c = classifyAdapterError(result({ errorMessage: "process lost" }))!;
    expect(c.code).toBe("process_lost");
    expect(c.retriable).toBe(true);
  });

  // -- Fatal errors -------------------------------------------------------

  it("classifies 401 as fatal/auth_failed", () => {
    const c = classifyAdapterError(result({ errorMessage: "401 Unauthorized" }))!;
    expect(c.category).toBe("fatal");
    expect(c.code).toBe("auth_failed");
    expect(c.retriable).toBe(false);
    expect(c.shouldPauseAgent).toBe(true);
  });

  it("classifies invalid API key as fatal/auth_failed", () => {
    const c = classifyAdapterError(result({ errorMessage: "Invalid API key provided" }))!;
    expect(c.code).toBe("auth_failed");
    expect(c.shouldPauseAgent).toBe(true);
  });

  it("classifies quota exhaustion as fatal/quota_exhausted", () => {
    const c = classifyAdapterError(result({ errorMessage: "Insufficient funds: billing limit reached" }))!;
    expect(c.code).toBe("quota_exhausted");
    expect(c.shouldPauseAgent).toBe(true);
  });

  it("classifies invalid model as fatal/invalid_model", () => {
    const c = classifyAdapterError(result({ errorMessage: "Model gpt-99 does not exist" }))!;
    expect(c.code).toBe("invalid_model");
    expect(c.shouldPauseAgent).toBe(true);
  });

  it("classifies adapter missing as fatal/adapter_missing", () => {
    const c = classifyAdapterError(result({ errorMessage: "adapter not found" }))!;
    expect(c.code).toBe("adapter_missing");
  });

  // -- Actionable errors --------------------------------------------------

  it("classifies max turns reached as actionable/max_turns", () => {
    const c = classifyAdapterError(result({ errorMessage: "max_turns_reached" }))!;
    expect(c.category).toBe("actionable");
    expect(c.code).toBe("max_turns");
    expect(c.retriable).toBe(false);
    expect(c.shouldPauseAgent).toBe(false);
  });

  it("classifies context overflow as actionable/context_overflow", () => {
    const c = classifyAdapterError(result({ errorMessage: "context length exceeded" }))!;
    expect(c.code).toBe("context_overflow");
  });

  it("classifies content policy as actionable/content_policy", () => {
    const c = classifyAdapterError(result({ errorMessage: "blocked by policy" }))!;
    expect(c.code).toBe("content_policy");
  });

  // -- ErrorCode field takes precedence -----------------------------------

  it("uses errorCode field when present", () => {
    const c = classifyAdapterError(result({
      errorCode: "rate_limit",
      errorMessage: "something generic",
    }))!;
    expect(c.code).toBe("rate_limit");
    expect(c.category).toBe("retriable");
  });

  // -- Stderr/stdout fallback ---------------------------------------------

  it("checks stderr when errorMessage does not match", () => {
    const c = classifyAdapterError(result({
      errorMessage: "adapter process exited unexpectedly",
      errorMeta: { stderr: "Error: 401 Unauthorized" },
    }))!;
    expect(c.code).toBe("auth_failed");
  });

  it("checks stdout when stderr does not match", () => {
    const c = classifyAdapterError(result({
      errorMessage: "",
      resultJson: { stdout: "rate limit exceeded", stderr: "" },
    }))!;
    expect(c.code).toBe("rate_limit");
  });

  // -- Default fallback ---------------------------------------------------

  it("defaults to retriable/transient for unknown errors", () => {
    const c = classifyAdapterError(result({
      exitCode: 137,
      errorMessage: "killed by OOM",
    }))!;
    expect(c.category).toBe("retriable");
    expect(c.code).toBe("transient");
    expect(c.retriable).toBe(true);
  });

  // -- Case insensitivity -------------------------------------------------

  it("matches patterns case-insensitively", () => {
    const c = classifyAdapterError(result({ errorMessage: "RATE LIMIT EXCEEDED" }))!;
    expect(c.code).toBe("rate_limit");
  });
});

// ---------------------------------------------------------------------------
// computeRetryDelay
// ---------------------------------------------------------------------------

describe("computeRetryDelay", () => {
  it("returns null for fatal errors", () => {
    expect(computeRetryDelay("auth_failed", "fatal", 0)).toBeNull();
  });

  it("returns null for actionable errors", () => {
    expect(computeRetryDelay("max_turns", "actionable", 0)).toBeNull();
  });

  it("returns a positive number for retriable errors", () => {
    const delay = computeRetryDelay("rate_limit", "retriable", 0);
    expect(delay).toBeTypeOf("number");
    expect(delay!).toBeGreaterThan(0);
  });

  it("increases delay with attempt count (exponential backoff)", () => {
    // Run multiple times to account for jitter; on average attempt 2 > attempt 0
    const delays0 = Array.from({ length: 20 }, () => computeRetryDelay("transient", "retriable", 0)!);
    const delays2 = Array.from({ length: 20 }, () => computeRetryDelay("transient", "retriable", 2)!);
    const avg0 = delays0.reduce((a, b) => a + b, 0) / delays0.length;
    const avg2 = delays2.reduce((a, b) => a + b, 0) / delays2.length;
    expect(avg2).toBeGreaterThan(avg0);
  });

  it("caps delay at 300 seconds", () => {
    const delay = computeRetryDelay("rate_limit", "retriable", 100);
    expect(delay!).toBeLessThanOrEqual(300);
  });
});

// ---------------------------------------------------------------------------
// formatClassification
// ---------------------------------------------------------------------------

describe("formatClassification", () => {
  it("formats a retriable classification with retry delay", () => {
    const c: ErrorClassification = {
      category: "retriable",
      code: "rate_limit",
      retriable: true,
      shouldPauseAgent: false,
      suggestedDelaySec: 60,
      message: "429 Too Many Requests",
    };
    const formatted = formatClassification(c);
    expect(formatted).toContain("[retriable/rate_limit]");
    expect(formatted).toContain("will retry in ~60s");
  });

  it("formats a fatal classification with pause message", () => {
    const c: ErrorClassification = {
      category: "fatal",
      code: "auth_failed",
      retriable: false,
      shouldPauseAgent: true,
      suggestedDelaySec: null,
      message: "Invalid API key",
    };
    const formatted = formatClassification(c);
    expect(formatted).toContain("[fatal/auth_failed]");
    expect(formatted).toContain("requires attention");
  });

  it("formats an actionable classification with manual action message", () => {
    const c: ErrorClassification = {
      category: "actionable",
      code: "max_turns",
      retriable: false,
      shouldPauseAgent: false,
      suggestedDelaySec: null,
      message: "Max turns reached",
    };
    const formatted = formatClassification(c);
    expect(formatted).toContain("[actionable/max_turns]");
    expect(formatted).toContain("needs manual action");
  });
});

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseClaudeStreamJson,
  describeClaudeFailure,
  detectClaudeLoginRequired,
  extractClaudeLoginUrl,
} from "../../src/server/parse.js";
import { buildNdjson } from "./helpers/fixture-loader.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures", "error-codes");

async function loadFixture(name: string): Promise<string> {
  return fs.readFile(path.join(FIXTURES_DIR, `${name}.jsonl`), "utf-8");
}

describe("error-codes: fixture-based", () => {
  describe("auth-required fixture", () => {
    it("detects login required from result text", async () => {
      const ndjson = await loadFixture("auth-required");
      const parsed = parseClaudeStreamJson(ndjson);
      const login = detectClaudeLoginRequired({
        parsed: parsed.resultJson,
        stdout: ndjson,
        stderr: "",
      });
      expect(login.requiresLogin).toBe(true);
    });

    it("marks result as an error", async () => {
      const ndjson = await loadFixture("auth-required");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.resultJson!.is_error).toBe(true);
    });
  });

  describe("rate-limited fixture", () => {
    it("does not flag rate limit as login required", async () => {
      const ndjson = await loadFixture("rate-limited");
      const parsed = parseClaudeStreamJson(ndjson);
      const login = detectClaudeLoginRequired({
        parsed: parsed.resultJson,
        stdout: ndjson,
        stderr: "",
      });
      expect(login.requiresLogin).toBe(false);
    });

    it("captures error detail in result", async () => {
      const ndjson = await loadFixture("rate-limited");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.resultJson!.is_error).toBe(true);
      const failure = describeClaudeFailure(parsed.resultJson!);
      expect(failure).toContain("429");
    });
  });

  describe("invalid-model fixture", () => {
    it("captures model error information", async () => {
      const ndjson = await loadFixture("invalid-model");
      const parsed = parseClaudeStreamJson(ndjson);
      const failure = describeClaudeFailure(parsed.resultJson!);
      expect(failure).toContain("nonexistent-model");
    });

    it("extracts error messages from errors array with object entries", async () => {
      const ndjson = await loadFixture("invalid-model");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.resultJson!.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "model_not_found" }),
        ]),
      );
    });
  });
});

describe("error-codes: describeClaudeFailure", () => {
  it("includes subtype in failure description", () => {
    const result = {
      subtype: "error",
      result: "Something went wrong",
      errors: [],
    };
    const desc = describeClaudeFailure(result);
    expect(desc).toContain("subtype=error");
    expect(desc).toContain("Something went wrong");
  });

  it("falls back to first error message when result is empty", () => {
    const result = {
      subtype: "error",
      result: "",
      errors: ["Connection refused"],
    };
    const desc = describeClaudeFailure(result);
    expect(desc).toContain("Connection refused");
  });

  it("returns null when no detail is available", () => {
    const result = {
      subtype: "",
      result: "",
      errors: [],
    };
    const desc = describeClaudeFailure(result);
    expect(desc).toBeNull();
  });
});

describe("error-codes: detectClaudeLoginRequired", () => {
  it("detects 'not logged in' message", () => {
    const login = detectClaudeLoginRequired({
      parsed: { result: "You are not logged in. Please log in first." },
      stdout: "",
      stderr: "",
    });
    expect(login.requiresLogin).toBe(true);
  });

  it("detects 'please run claude login' message", () => {
    const login = detectClaudeLoginRequired({
      parsed: null,
      stdout: "",
      stderr: "Please run `claude login` to authenticate",
    });
    expect(login.requiresLogin).toBe(true);
  });

  it("detects 'authentication required' message", () => {
    const login = detectClaudeLoginRequired({
      parsed: { result: "Authentication required" },
      stdout: "",
      stderr: "",
    });
    expect(login.requiresLogin).toBe(true);
  });

  it("returns false for normal errors", () => {
    const login = detectClaudeLoginRequired({
      parsed: { result: "Rate limit exceeded" },
      stdout: "",
      stderr: "",
    });
    expect(login.requiresLogin).toBe(false);
  });

  it("returns false for null parsed and empty output", () => {
    const login = detectClaudeLoginRequired({
      parsed: null,
      stdout: "",
      stderr: "",
    });
    expect(login.requiresLogin).toBe(false);
  });
});

describe("error-codes: extractClaudeLoginUrl", () => {
  it("extracts anthropic auth URL from text", () => {
    const url = extractClaudeLoginUrl(
      "Please visit https://console.anthropic.com/auth/login to authenticate",
    );
    expect(url).toBe("https://console.anthropic.com/auth/login");
  });

  it("extracts claude URL from text", () => {
    const url = extractClaudeLoginUrl(
      "Open https://claude.ai/settings/api to get your API key",
    );
    expect(url).toContain("claude.ai");
  });

  it("returns null when no URL is present", () => {
    const url = extractClaudeLoginUrl("No URLs here");
    expect(url).toBeNull();
  });

  it("cleans trailing punctuation from URLs", () => {
    const url = extractClaudeLoginUrl(
      "Visit https://console.anthropic.com/auth/login.",
    );
    expect(url).not.toMatch(/\.$/);
  });
});

describe("error-codes: stderr vs stdout routing", () => {
  it("prefers parsed result errors over raw output", () => {
    const ndjson = buildNdjson([
      {
        type: "result",
        subtype: "error",
        is_error: true,
        result: "Model not found",
        errors: ["The model specified does not exist"],
      },
    ]);
    const parsed = parseClaudeStreamJson(ndjson);
    const failure = describeClaudeFailure(parsed.resultJson!);
    expect(failure).toContain("Model not found");
  });

  it("error shape is stable: always has type, subtype, is_error", () => {
    const ndjson = buildNdjson([
      {
        type: "result",
        subtype: "error",
        is_error: true,
        result: "generic error",
        errors: [],
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
      },
    ]);
    const parsed = parseClaudeStreamJson(ndjson);
    expect(parsed.resultJson).toHaveProperty("type", "result");
    expect(parsed.resultJson).toHaveProperty("subtype", "error");
    expect(parsed.resultJson).toHaveProperty("is_error", true);
  });
});

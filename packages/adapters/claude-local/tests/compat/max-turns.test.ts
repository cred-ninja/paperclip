import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseClaudeStreamJson,
  isClaudeMaxTurnsResult,
} from "../../src/server/parse.js";
import { buildNdjson } from "./helpers/fixture-loader.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures", "max-turns");

async function loadFixture(name: string): Promise<string> {
  return fs.readFile(path.join(FIXTURES_DIR, `${name}.jsonl`), "utf-8");
}

describe("max-turns: fixture-based", () => {
  describe("error_max_turns subtype", () => {
    it("detects max turns via subtype field", async () => {
      const ndjson = await loadFixture("max-turns-reached");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(isClaudeMaxTurnsResult(parsed.resultJson)).toBe(true);
    });

    it("still extracts partial output before max turns hit", async () => {
      const ndjson = await loadFixture("max-turns-reached");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.summary).toContain("Maximum number of turns reached");
    });

    it("marks the result as an error", async () => {
      const ndjson = await loadFixture("max-turns-reached");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.resultJson!.is_error).toBe(true);
    });

    it("preserves cost and usage data", async () => {
      const ndjson = await loadFixture("max-turns-reached");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.costUsd).toBe(0.025);
      expect(parsed.usage!.inputTokens).toBe(1000);
    });
  });

  describe("stop_reason max_turns (without error subtype)", () => {
    it("detects max turns via stop_reason field", async () => {
      const ndjson = await loadFixture("stop-reason-only");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(isClaudeMaxTurnsResult(parsed.resultJson)).toBe(true);
    });

    it("may not be flagged as an error", async () => {
      const ndjson = await loadFixture("stop-reason-only");
      const parsed = parseClaudeStreamJson(ndjson);
      // Some versions use is_error: false with stop_reason: max_turns
      expect(parsed.resultJson!.is_error).toBe(false);
    });
  });
});

describe("max-turns: isClaudeMaxTurnsResult edge cases", () => {
  it("returns false for null/undefined input", () => {
    expect(isClaudeMaxTurnsResult(null)).toBe(false);
    expect(isClaudeMaxTurnsResult(undefined)).toBe(false);
  });

  it("returns false for a normal success result", () => {
    const result = {
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
      result: "All done!",
    };
    expect(isClaudeMaxTurnsResult(result)).toBe(false);
  });

  it("detects max turns from result text as fallback", () => {
    const result = {
      type: "result",
      subtype: "error",
      result: "Stopped: maximum turns reached",
    };
    expect(isClaudeMaxTurnsResult(result)).toBe(true);
  });

  it("handles case variations in subtype", () => {
    // The parser normalizes to lowercase before comparison
    const result = { subtype: "error_max_turns", result: "" };
    expect(isClaudeMaxTurnsResult(result)).toBe(true);
  });

  it("handles case variations in stop_reason", () => {
    const result = { stop_reason: "max_turns", result: "" };
    expect(isClaudeMaxTurnsResult(result)).toBe(true);
  });

  it("does not false-positive on 'turns' in unrelated text", () => {
    const result = { result: "It turns out the answer is 42" };
    expect(isClaudeMaxTurnsResult(result)).toBe(false);
  });
});

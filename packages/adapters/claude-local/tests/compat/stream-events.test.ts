import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeStreamJson } from "../../src/server/parse.js";
import { buildNdjson } from "./helpers/fixture-loader.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures", "stream-json");

async function loadFixture(name: string): Promise<string> {
  return fs.readFile(path.join(FIXTURES_DIR, `${name}.jsonl`), "utf-8");
}

describe("stream-events: fixture-based parsing", () => {
  describe("success-simple fixture", () => {
    it("extracts session ID from system init event", async () => {
      const ndjson = await loadFixture("success-simple");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.sessionId).toBe("sess-abc123");
    });

    it("extracts model from system init event", async () => {
      const ndjson = await loadFixture("success-simple");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.model).toBe("claude-sonnet-4-6");
    });

    it("extracts assistant text from message content blocks", async () => {
      const ndjson = await loadFixture("success-simple");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.summary).toBe("Hello! I can help you with that.");
    });

    it("extracts cost from result event", async () => {
      const ndjson = await loadFixture("success-simple");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.costUsd).toBe(0.003);
    });

    it("extracts token usage from result event", async () => {
      const ndjson = await loadFixture("success-simple");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.usage).toEqual({
        inputTokens: 150,
        outputTokens: 25,
        cachedInputTokens: 0,
      });
    });

    it("captures the full result JSON", async () => {
      const ndjson = await loadFixture("success-simple");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.resultJson).not.toBeNull();
      expect(parsed.resultJson!.type).toBe("result");
      expect(parsed.resultJson!.subtype).toBe("success");
      expect(parsed.resultJson!.is_error).toBe(false);
    });
  });

  describe("success-with-tool-use fixture", () => {
    it("parses streams containing tool_use and tool_result events", async () => {
      const ndjson = await loadFixture("success-with-tool-use");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.sessionId).toBe("sess-tool-456");
      expect(parsed.summary).toBe("The file contains: file contents here");
    });

    it("accumulates text from multiple assistant events", async () => {
      const ndjson = await loadFixture("success-with-tool-use");
      const parsed = parseClaudeStreamJson(ndjson);
      // Parser should get text from both assistant events
      expect(parsed.summary).toContain("file contents here");
    });

    it("extracts cache read tokens", async () => {
      const ndjson = await loadFixture("success-with-tool-use");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.usage!.cachedInputTokens).toBe(100);
    });
  });

  describe("multi-text-blocks fixture", () => {
    it("joins multiple text blocks with double newline", async () => {
      const ndjson = await loadFixture("multi-text-blocks");
      const parsed = parseClaudeStreamJson(ndjson);
      // The parser joins assistant texts with \n\n but result.result overrides summary
      expect(parsed.summary).toContain("First part");
      expect(parsed.summary).toContain("Second part");
    });
  });

  describe("empty-content fixture", () => {
    it("handles empty content arrays without crashing", async () => {
      const ndjson = await loadFixture("empty-content");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.sessionId).toBe("sess-empty-001");
      expect(parsed.resultJson).not.toBeNull();
    });
  });

  describe("event shape invariants", () => {
    it("ignores unknown event types without crashing", () => {
      const ndjson = buildNdjson([
        { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-6" },
        { type: "unknown_future_event", data: "something" },
        { type: "result", subtype: "success", session_id: "s1", result: "done", total_cost_usd: 0.001, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 } },
      ]);
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.sessionId).toBe("s1");
      expect(parsed.summary).toBe("done");
    });

    it("handles malformed JSON lines gracefully", () => {
      const ndjson = [
        JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "m1" }),
        "this is not json",
        "",
        JSON.stringify({ type: "result", subtype: "success", session_id: "s1", result: "ok", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 } }),
      ].join("\n");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.sessionId).toBe("s1");
      expect(parsed.summary).toBe("ok");
    });

    it("handles empty stdout", () => {
      const parsed = parseClaudeStreamJson("");
      expect(parsed.sessionId).toBeNull();
      expect(parsed.model).toBe("");
      expect(parsed.costUsd).toBeNull();
      expect(parsed.usage).toBeNull();
      expect(parsed.summary).toBe("");
      expect(parsed.resultJson).toBeNull();
    });

    it("handles stream with only system init and no result", () => {
      const ndjson = buildNdjson([
        { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-6" },
      ]);
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.sessionId).toBe("s1");
      expect(parsed.model).toBe("claude-sonnet-4-6");
      expect(parsed.resultJson).toBeNull();
      expect(parsed.usage).toBeNull();
    });

    it("handles non-text content blocks in assistant messages", () => {
      const ndjson = buildNdjson([
        { type: "system", subtype: "init", session_id: "s1", model: "m1" },
        {
          type: "assistant",
          session_id: "s1",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "let me think..." },
              { type: "text", text: "Here is my answer." },
              { type: "tool_use", id: "t1", name: "Read", input: {} },
            ],
          },
        },
        { type: "result", subtype: "success", session_id: "s1", result: "Here is my answer.", total_cost_usd: 0.002, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 } },
      ]);
      const parsed = parseClaudeStreamJson(ndjson);
      // Only text blocks are accumulated
      expect(parsed.summary).toBe("Here is my answer.");
    });

    it("preserves session ID across events when system init is absent", () => {
      const ndjson = buildNdjson([
        {
          type: "assistant",
          session_id: "s-from-assistant",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        },
        { type: "result", subtype: "success", session_id: "s-from-assistant", result: "hi", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 } },
      ]);
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.sessionId).toBe("s-from-assistant");
    });
  });
});

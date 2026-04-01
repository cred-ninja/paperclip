import { describe, expect, it } from "vitest";
import { parseClaudeStreamJson } from "./parse.js";

function line(obj: Record<string, unknown>) {
  return JSON.stringify(obj);
}

function buildStream(...events: Record<string, unknown>[]) {
  return events.map(line).join("\n");
}

describe("parseClaudeStreamJson", () => {
  describe("tool_use extraction", () => {
    it("should extract tool_use blocks from assistant messages", () => {
      const stdout = buildStream(
        { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-20250514" },
        {
          type: "assistant",
          session_id: "s1",
          message: {
            content: [
              { type: "text", text: "Let me read that file." },
              { type: "tool_use", id: "tu_01", name: "Read", input: { file_path: "/src/main.ts" } },
            ],
          },
        },
        { type: "result", session_id: "s1", result: "Done", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 }, total_cost_usd: 0.01 },
      );

      const parsed = parseClaudeStreamJson(stdout);
      expect(parsed.toolTrace).toHaveLength(1);
      expect(parsed.toolTrace[0]).toEqual({
        kind: "tool_call",
        name: "Read",
        toolUseId: "tu_01",
        input: { file_path: "/src/main.ts" },
      });
    });

    it("should extract tool_use blocks using tool_use_id field", () => {
      const stdout = buildStream(
        { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-20250514" },
        {
          type: "assistant",
          session_id: "s1",
          message: {
            content: [
              { type: "tool_use", tool_use_id: "tu_02", name: "Bash", input: { command: "ls" } },
            ],
          },
        },
        { type: "result", session_id: "s1", result: "Done", usage: { input_tokens: 50, output_tokens: 25, cache_read_input_tokens: 0 }, total_cost_usd: 0.005 },
      );

      const parsed = parseClaudeStreamJson(stdout);
      expect(parsed.toolTrace).toHaveLength(1);
      expect(parsed.toolTrace[0]).toEqual({
        kind: "tool_call",
        name: "Bash",
        toolUseId: "tu_02",
        input: { command: "ls" },
      });
    });
  });

  describe("tool_result extraction", () => {
    it("should extract tool_result blocks from user messages with string content", () => {
      const stdout = buildStream(
        { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-20250514" },
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "tu_01", content: "file contents here", is_error: false },
            ],
          },
        },
        { type: "result", session_id: "s1", result: "Done", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 }, total_cost_usd: 0.01 },
      );

      const parsed = parseClaudeStreamJson(stdout);
      expect(parsed.toolTrace).toHaveLength(1);
      expect(parsed.toolTrace[0]).toEqual({
        kind: "tool_result",
        toolUseId: "tu_01",
        content: "file contents here",
        isError: false,
      });
    });

    it("should extract tool_result with array content blocks", () => {
      const stdout = buildStream(
        { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-20250514" },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_03",
                content: [{ type: "text", text: "line 1" }, { type: "text", text: "line 2" }],
                is_error: false,
              },
            ],
          },
        },
        { type: "result", session_id: "s1", result: "Done", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 }, total_cost_usd: 0.01 },
      );

      const parsed = parseClaudeStreamJson(stdout);
      expect(parsed.toolTrace).toHaveLength(1);
      expect(parsed.toolTrace[0]).toEqual({
        kind: "tool_result",
        toolUseId: "tu_03",
        content: "line 1\nline 2",
        isError: false,
      });
    });

    it("should flag error results correctly", () => {
      const stdout = buildStream(
        { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-20250514" },
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "tu_04", content: "Permission denied", is_error: true },
            ],
          },
        },
        { type: "result", session_id: "s1", result: "Failed", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 }, total_cost_usd: 0.01 },
      );

      const parsed = parseClaudeStreamJson(stdout);
      expect(parsed.toolTrace).toHaveLength(1);
      expect(parsed.toolTrace[0]).toEqual({
        kind: "tool_result",
        toolUseId: "tu_04",
        content: "Permission denied",
        isError: true,
      });
    });
  });

  describe("multi-step tool trace", () => {
    it("should preserve order of tool_call and tool_result across messages", () => {
      const stdout = buildStream(
        { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-20250514" },
        {
          type: "assistant",
          session_id: "s1",
          message: {
            content: [
              { type: "text", text: "Reading file." },
              { type: "tool_use", id: "tu_10", name: "Read", input: { file_path: "/a.ts" } },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "tu_10", content: "export const a = 1;", is_error: false },
            ],
          },
        },
        {
          type: "assistant",
          session_id: "s1",
          message: {
            content: [
              { type: "tool_use", id: "tu_11", name: "Edit", input: { file_path: "/a.ts", old_string: "1", new_string: "2" } },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "tu_11", content: "File edited", is_error: false },
            ],
          },
        },
        { type: "result", session_id: "s1", result: "Done", usage: { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 0 }, total_cost_usd: 0.02 },
      );

      const parsed = parseClaudeStreamJson(stdout);
      expect(parsed.toolTrace).toHaveLength(4);
      expect(parsed.toolTrace[0]).toEqual({ kind: "tool_call", name: "Read", toolUseId: "tu_10", input: { file_path: "/a.ts" } });
      expect(parsed.toolTrace[1]).toEqual({ kind: "tool_result", toolUseId: "tu_10", content: "export const a = 1;", isError: false });
      expect(parsed.toolTrace[2]).toEqual({ kind: "tool_call", name: "Edit", toolUseId: "tu_11", input: { file_path: "/a.ts", old_string: "1", new_string: "2" } });
      expect(parsed.toolTrace[3]).toEqual({ kind: "tool_result", toolUseId: "tu_11", content: "File edited", isError: false });
    });
  });

  describe("empty tool trace", () => {
    it("should return empty toolTrace when no tool events exist", () => {
      const stdout = buildStream(
        { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-20250514" },
        {
          type: "assistant",
          session_id: "s1",
          message: { content: [{ type: "text", text: "Hello!" }] },
        },
        { type: "result", session_id: "s1", result: "Hello!", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 }, total_cost_usd: 0.001 },
      );

      const parsed = parseClaudeStreamJson(stdout);
      expect(parsed.toolTrace).toEqual([]);
    });

    it("should return empty toolTrace when no result event", () => {
      const stdout = buildStream(
        { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-20250514" },
      );

      const parsed = parseClaudeStreamJson(stdout);
      expect(parsed.toolTrace).toEqual([]);
      expect(parsed.resultJson).toBeNull();
    });
  });

  describe("skips malformed entries", () => {
    it("should skip tool_use without an id", () => {
      const stdout = buildStream(
        { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-20250514" },
        {
          type: "assistant",
          session_id: "s1",
          message: {
            content: [
              { type: "tool_use", name: "Read", input: {} },
            ],
          },
        },
        { type: "result", session_id: "s1", result: "Done", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 }, total_cost_usd: 0.001 },
      );

      const parsed = parseClaudeStreamJson(stdout);
      expect(parsed.toolTrace).toEqual([]);
    });

    it("should skip tool_result without a tool_use_id", () => {
      const stdout = buildStream(
        { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-20250514" },
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", content: "orphaned", is_error: false },
            ],
          },
        },
        { type: "result", session_id: "s1", result: "Done", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 }, total_cost_usd: 0.001 },
      );

      const parsed = parseClaudeStreamJson(stdout);
      expect(parsed.toolTrace).toEqual([]);
    });
  });

  describe("existing fields remain correct", () => {
    it("should still extract text, session, model, usage, and cost", () => {
      const stdout = buildStream(
        { type: "system", subtype: "init", session_id: "sess-abc", model: "claude-sonnet-4-20250514" },
        {
          type: "assistant",
          session_id: "sess-abc",
          message: {
            content: [
              { type: "text", text: "I'll help with that." },
              { type: "tool_use", id: "tu_99", name: "Read", input: { file_path: "/x.ts" } },
            ],
          },
        },
        { type: "result", session_id: "sess-abc", result: "All done.", usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 100 }, total_cost_usd: 0.05 },
      );

      const parsed = parseClaudeStreamJson(stdout);
      expect(parsed.sessionId).toBe("sess-abc");
      expect(parsed.model).toBe("claude-sonnet-4-20250514");
      expect(parsed.costUsd).toBe(0.05);
      expect(parsed.usage).toEqual({ inputTokens: 500, cachedInputTokens: 100, outputTokens: 200 });
      expect(parsed.summary).toBe("All done.");
      expect(parsed.toolTrace).toHaveLength(1);
    });
  });
});

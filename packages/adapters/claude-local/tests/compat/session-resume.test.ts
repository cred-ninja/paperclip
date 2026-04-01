import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseClaudeStreamJson,
  isClaudeUnknownSessionError,
} from "../../src/server/parse.js";
import { sessionCodec } from "../../src/server/index.js";
import { buildNdjson } from "./helpers/fixture-loader.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures", "session-resume");

async function loadFixture(name: string): Promise<string> {
  return fs.readFile(path.join(FIXTURES_DIR, `${name}.jsonl`), "utf-8");
}

describe("session-resume: fixture-based", () => {
  describe("successful resume", () => {
    it("preserves session ID through a resumed conversation", async () => {
      const ndjson = await loadFixture("successful-resume");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.sessionId).toBe("sess-resume-001");
    });

    it("returns valid usage for resumed sessions", async () => {
      const ndjson = await loadFixture("successful-resume");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.usage).not.toBeNull();
      expect(parsed.usage!.cachedInputTokens).toBe(250);
    });
  });

  describe("unknown session error", () => {
    it("detects unknown session error from result text", async () => {
      const ndjson = await loadFixture("unknown-session");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.resultJson).not.toBeNull();
      expect(isClaudeUnknownSessionError(parsed.resultJson!)).toBe(true);
    });

    it("detects various unknown session error messages", () => {
      const variants = [
        "no conversation found with session id sess-123",
        "unknown session",
        "session abc-def not found",
      ];
      for (const msg of variants) {
        const result = { result: msg };
        expect(isClaudeUnknownSessionError(result)).toBe(true);
      }
    });

    it("does not false-positive on unrelated error messages", () => {
      const unrelated = [
        "Rate limit exceeded",
        "Model not found",
        "Connection reset",
        "session started successfully",
      ];
      for (const msg of unrelated) {
        const result = { result: msg };
        expect(isClaudeUnknownSessionError(result)).toBe(false);
      }
    });
  });
});

describe("session-resume: session codec", () => {
  it("round-trips session params through serialize/deserialize", () => {
    const params = {
      sessionId: "sess-codec-001",
      cwd: "/tmp/test",
    };
    const serialized = sessionCodec.serialize(params);
    expect(serialized).not.toBeNull();
    const deserialized = sessionCodec.deserialize(serialized!);
    expect(deserialized).not.toBeNull();
    expect(deserialized!.sessionId).toBe("sess-codec-001");
    expect(deserialized!.cwd).toBe("/tmp/test");
  });

  it("handles snake_case input for backwards compatibility", () => {
    const snakeCase = {
      session_id: "sess-snake-001",
      cwd: "/tmp/snake",
    };
    const deserialized = sessionCodec.deserialize(snakeCase);
    expect(deserialized).not.toBeNull();
    expect(deserialized!.sessionId).toBe("sess-snake-001");
  });

  it("returns display ID from session params", () => {
    const params = { sessionId: "sess-display-001" };
    expect(sessionCodec.getDisplayId(params)).toBe("sess-display-001");
  });

  it("returns null for empty session params", () => {
    expect(sessionCodec.deserialize({})).toBeNull();
    expect(sessionCodec.deserialize(null)).toBeNull();
  });

  it("preserves optional workspace fields", () => {
    const params = {
      sessionId: "sess-ws-001",
      cwd: "/tmp/ws",
      workspaceId: "ws-123",
      repoUrl: "https://github.com/test/repo",
      repoRef: "main",
    };
    const serialized = sessionCodec.serialize(params);
    const deserialized = sessionCodec.deserialize(serialized!);
    expect(deserialized!.workspaceId).toBe("ws-123");
    expect(deserialized!.repoUrl).toBe("https://github.com/test/repo");
    expect(deserialized!.repoRef).toBe("main");
  });
});

describe("session-resume: cwd matching logic", () => {
  it("should allow resume when cwd matches exactly", () => {
    // Simulating the logic from execute.ts
    const runtimeSessionId = "sess-001";
    const runtimeSessionCwd = "/tmp/project";
    const cwd = "/tmp/project";
    const canResume =
      runtimeSessionId.length > 0 &&
      (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
    expect(canResume).toBe(true);
  });

  it("should allow resume when saved cwd is empty", () => {
    const runtimeSessionId = "sess-002";
    const runtimeSessionCwd = "";
    const cwd = "/tmp/anywhere";
    const canResume =
      runtimeSessionId.length > 0 &&
      (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
    expect(canResume).toBe(true);
  });

  it("should reject resume when cwd does not match", () => {
    const runtimeSessionId = "sess-003";
    const runtimeSessionCwd = "/tmp/project-a";
    const cwd = "/tmp/project-b";
    const canResume =
      runtimeSessionId.length > 0 &&
      (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
    expect(canResume).toBe(false);
  });

  it("should reject resume when session ID is empty", () => {
    const runtimeSessionId = "";
    const runtimeSessionCwd = "";
    const cwd = "/tmp/project";
    const canResume =
      runtimeSessionId.length > 0 &&
      (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
    expect(canResume).toBe(false);
  });
});

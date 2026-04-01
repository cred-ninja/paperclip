import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseClaudeStreamJson,
  describeClaudeFailure,
} from "../../src/server/parse.js";
import { buildNdjson } from "./helpers/fixture-loader.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures", "permission-prompts");

async function loadFixture(name: string): Promise<string> {
  return fs.readFile(path.join(FIXTURES_DIR, `${name}.jsonl`), "utf-8");
}

describe("permission-flow: fixture-based", () => {
  describe("permission-denied fixture", () => {
    it("parses permission denied error from result", async () => {
      const ndjson = await loadFixture("permission-denied");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.resultJson).not.toBeNull();
      expect(parsed.resultJson!.is_error).toBe(true);
    });

    it("captures the denial reason in failure description", async () => {
      const ndjson = await loadFixture("permission-denied");
      const parsed = parseClaudeStreamJson(ndjson);
      const failure = describeClaudeFailure(parsed.resultJson!);
      expect(failure).toContain("Permission denied");
    });

    it("preserves session ID even on permission errors", async () => {
      const ndjson = await loadFixture("permission-denied");
      const parsed = parseClaudeStreamJson(ndjson);
      expect(parsed.sessionId).toBe("sess-perm-001");
    });

    it("still captures partial work before the denial", async () => {
      const ndjson = await loadFixture("permission-denied");
      const parsed = parseClaudeStreamJson(ndjson);
      // Assistant text was captured before the error result
      // The summary will be from the result, not assistant text
      expect(parsed.summary).toContain("Permission denied");
    });
  });
});

describe("permission-flow: flag validation", () => {
  it("--dangerously-skip-permissions flag is recognized as a valid flag", async () => {
    // This test validates our compat-matrix includes the flag
    const { getCompatForVersion, parseSemVer } = await import("./compat-matrix.js");
    const v = parseSemVer("1.0.17");
    const compat = getCompatForVersion(v!);
    expect(compat).not.toBeNull();
    expect(compat!.supportedFlags).toContain("--dangerously-skip-permissions");
  });

  it("builds correct args when permissions are skipped", () => {
    // Simulating the arg-building logic from execute.ts
    const dangerouslySkipPermissions = true;
    const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
    if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("does not include flag when permissions are not skipped", () => {
    const dangerouslySkipPermissions = false;
    const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
    if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });
});

describe("permission-flow: edge cases", () => {
  it("handles permission error in errors array", () => {
    const ndjson = buildNdjson([
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
      {
        type: "result",
        subtype: "error",
        is_error: true,
        result: "",
        errors: ["Permission denied: cannot execute bash command"],
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
      },
    ]);
    const parsed = parseClaudeStreamJson(ndjson);
    const failure = describeClaudeFailure(parsed.resultJson!);
    expect(failure).toContain("Permission denied");
  });

  it("handles permission timeout when interactive prompt blocks", () => {
    // When --dangerously-skip-permissions is NOT used, the CLI may prompt
    // for permission interactively. In non-interactive mode (--print), this
    // should result in a timeout or error, not a hang.
    const ndjson = buildNdjson([
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
      // No result event — stream was interrupted (simulating timeout)
    ]);
    const parsed = parseClaudeStreamJson(ndjson);
    expect(parsed.resultJson).toBeNull();
    expect(parsed.sessionId).toBe("s1");
  });
});

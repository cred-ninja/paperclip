import { describe, expect, it } from "vitest";
import {
  parseSemVer,
  versionToNumber,
  isVersionSupported,
  getCompatForVersion,
  getSkippedTests,
  MINIMUM_SUPPORTED_VERSION,
} from "./compat-matrix.js";

describe("parseSemVer", () => {
  it("parses a standard version string", () => {
    const v = parseSemVer("1.0.17");
    expect(v).toEqual({
      major: 1,
      minor: 0,
      patch: 17,
      prerelease: null,
      raw: "1.0.17",
    });
  });

  it("strips leading v prefix", () => {
    const v = parseSemVer("v2.3.1");
    expect(v).toEqual({
      major: 2,
      minor: 3,
      patch: 1,
      prerelease: null,
      raw: "2.3.1",
    });
  });

  it("parses prerelease identifiers", () => {
    const v = parseSemVer("1.0.0-beta.1");
    expect(v).not.toBeNull();
    expect(v!.prerelease).toBe("beta.1");
  });

  it("returns null for invalid input", () => {
    expect(parseSemVer("not-a-version")).toBeNull();
    expect(parseSemVer("")).toBeNull();
    expect(parseSemVer("1.0")).toBeNull();
  });

  it("handles whitespace", () => {
    const v = parseSemVer("  1.2.3  ");
    expect(v).not.toBeNull();
    expect(v!.major).toBe(1);
  });
});

describe("versionToNumber", () => {
  it("converts version to sortable number", () => {
    const v1 = parseSemVer("1.0.0")!;
    const v2 = parseSemVer("1.0.17")!;
    const v3 = parseSemVer("2.0.0")!;
    expect(versionToNumber(v1)).toBeLessThan(versionToNumber(v2));
    expect(versionToNumber(v2)).toBeLessThan(versionToNumber(v3));
  });
});

describe("isVersionSupported", () => {
  it("returns true for minimum version", () => {
    expect(isVersionSupported(MINIMUM_SUPPORTED_VERSION)).toBe(true);
  });

  it("returns true for versions above minimum", () => {
    const v = parseSemVer("1.0.17")!;
    expect(isVersionSupported(v)).toBe(true);
  });

  it("returns false for versions below minimum", () => {
    const v = parseSemVer("0.9.99")!;
    expect(isVersionSupported(v)).toBe(false);
  });
});

describe("getCompatForVersion", () => {
  it("returns early entry for pre-1.0.17 versions", () => {
    const v = parseSemVer("1.0.10")!;
    const compat = getCompatForVersion(v);
    expect(compat).not.toBeNull();
    expect(compat!.supportedFlags).toContain("--print");
    expect(compat!.supportedFlags).not.toContain("--effort");
  });

  it("returns latest entry for post-1.0.17 versions", () => {
    const v = parseSemVer("1.0.17")!;
    const compat = getCompatForVersion(v);
    expect(compat).not.toBeNull();
    expect(compat!.supportedFlags).toContain("--effort");
    expect(compat!.supportedFlags).toContain("--append-system-prompt-file");
  });

  it("returns null for unsupported versions", () => {
    const v = parseSemVer("0.1.0")!;
    expect(getCompatForVersion(v)).toBeNull();
  });
});

describe("getSkippedTests", () => {
  it("returns affected tests for versions with known issues", () => {
    const v = parseSemVer("1.0.10")!;
    const skipped = getSkippedTests(v);
    expect(skipped).toContain("stream-events");
  });

  it("returns empty array for versions without known issues", () => {
    const v = parseSemVer("1.0.17")!;
    const skipped = getSkippedTests(v);
    expect(skipped).toEqual([]);
  });
});

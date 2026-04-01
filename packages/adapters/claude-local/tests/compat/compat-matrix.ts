export interface KnownIssue {
  id: string;
  description: string;
  affectedTests: string[];
}

export interface CompatEntry {
  versionRange: string;
  supportedFlags: string[];
  knownIssues: KnownIssue[];
}

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
  raw: string;
}

export function parseSemVer(raw: string): SemVer | null {
  const cleaned = raw.replace(/^v/i, "").trim();
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
    raw: cleaned,
  };
}

export function versionToNumber(v: SemVer): number {
  return v.major * 1_000_000 + v.minor * 1_000 + v.patch;
}

function parseRange(range: string): { min: number; max: number } | null {
  const match = range.match(/^>=(\d+\.\d+\.\d+)\s*(?:,\s*<(\d+\.\d+\.\d+))?$/);
  if (!match) return null;
  const minV = parseSemVer(match[1]!);
  if (!minV) return null;
  const maxV = match[2] ? parseSemVer(match[2]) : null;
  return {
    min: versionToNumber(minV),
    max: maxV ? versionToNumber(maxV) : Number.MAX_SAFE_INTEGER,
  };
}

export const COMPAT_MATRIX: CompatEntry[] = [
  {
    versionRange: ">=1.0.0, <1.0.17",
    supportedFlags: [
      "--print",
      "--output-format",
      "--verbose",
      "--resume",
      "--dangerously-skip-permissions",
      "--max-turns",
      "--model",
    ],
    knownIssues: [
      {
        id: "CLV-001",
        description: "stream-json may emit malformed JSON on interrupt (fixed 1.0.17)",
        affectedTests: ["stream-events"],
      },
    ],
  },
  {
    versionRange: ">=1.0.17",
    supportedFlags: [
      "--print",
      "--output-format",
      "--verbose",
      "--resume",
      "--dangerously-skip-permissions",
      "--max-turns",
      "--model",
      "--effort",
      "--append-system-prompt-file",
      "--add-dir",
      "--chrome",
    ],
    knownIssues: [],
  },
];

export const MINIMUM_SUPPORTED_VERSION: SemVer = {
  major: 1,
  minor: 0,
  patch: 0,
  prerelease: null,
  raw: "1.0.0",
};

export function getCompatForVersion(version: SemVer): CompatEntry | null {
  const num = versionToNumber(version);
  for (const entry of COMPAT_MATRIX) {
    const range = parseRange(entry.versionRange);
    if (!range) continue;
    if (num >= range.min && num < range.max) return entry;
  }
  return null;
}

export function isVersionSupported(version: SemVer): boolean {
  return versionToNumber(version) >= versionToNumber(MINIMUM_SUPPORTED_VERSION);
}

export function getSkippedTests(version: SemVer): string[] {
  const compat = getCompatForVersion(version);
  if (!compat) return [];
  return compat.knownIssues.flatMap((issue) => issue.affectedTests);
}

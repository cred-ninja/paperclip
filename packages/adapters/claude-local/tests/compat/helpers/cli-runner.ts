import { spawn } from "node:child_process";
import { parseSemVer, type SemVer } from "../compat-matrix.js";

export interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

export async function runClaude(
  args: string[],
  options?: {
    cwd?: string;
    stdin?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  },
): Promise<CliRunResult> {
  const timeoutMs = options?.timeoutMs ?? 60_000;

  return new Promise<CliRunResult>((resolve) => {
    const proc = spawn("claude", args, {
      cwd: options?.cwd ?? process.cwd(),
      env: { ...process.env, ...options?.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5_000);
    }, timeoutMs);

    if (options?.stdin) {
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }

    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        signal: signal?.toString() ?? null,
        timedOut,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + (err.message ?? ""),
        exitCode: null,
        signal: null,
        timedOut: false,
      });
    });
  });
}

export async function getClaudeVersion(): Promise<SemVer | null> {
  const result = await runClaude(["--version"], { timeoutMs: 10_000 });
  if (result.exitCode !== 0) return null;
  const output = (result.stdout + result.stderr).trim();
  // Claude CLI outputs version in various formats: "1.0.17", "claude 1.0.17", etc.
  const versionMatch = output.match(/(\d+\.\d+\.\d+(?:-[^\s]+)?)/);
  if (!versionMatch) return null;
  return parseSemVer(versionMatch[1]!);
}

export function isClaudeCliAvailable(): Promise<boolean> {
  return getClaudeVersion().then((v) => v !== null).catch(() => false);
}

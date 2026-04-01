import fs from "node:fs/promises";
import path from "node:path";

const FIXTURES_DIR = path.resolve(import.meta.dirname ?? __dirname, "..", "fixtures");

export async function loadFixture(category: string, name: string): Promise<string> {
  const filePath = path.join(FIXTURES_DIR, category, `${name}.jsonl`);
  return fs.readFile(filePath, "utf-8");
}

export async function loadFixtureJson<T = unknown>(category: string, name: string): Promise<T> {
  const filePath = path.join(FIXTURES_DIR, category, `${name}.json`);
  const content = await fs.readFile(filePath, "utf-8");
  return JSON.parse(content) as T;
}

export function fixturesDir(category: string): string {
  return path.join(FIXTURES_DIR, category);
}

/**
 * Build NDJSON (newline-delimited JSON) from an array of event objects.
 * Used to create inline test fixtures without reading files.
 */
export function buildNdjson(events: Record<string, unknown>[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

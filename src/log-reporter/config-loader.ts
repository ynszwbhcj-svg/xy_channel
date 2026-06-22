// Config loader: reads JSON config file, validates fields, resolves date wildcards to actual files
import { readFileSync, readdirSync } from "fs";
import { dirname, basename, join } from "path";
import type { LogReporterConfig } from "./types.js";

// Replace longer tokens first to avoid partial matches
const WILDCARD_TOKENS: [string, string][] = [
  ["{year-month-day}", "\\d{4}-\\d{2}-\\d{2}"],
  ["{year}{month}{day}", "\\d{8}"],
  ["{year}", "\\d{4}"],
  ["{month}", "\\d{2}"],
  ["{day}", "\\d{2}"],
];

/**
 * Load and validate the JSON config file.
 * Falls back to defaults for optional fields.
 */
export function loadConfig(configPath: string): LogReporterConfig {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw);

  if (!parsed.logFiles || !Array.isArray(parsed.logFiles) || parsed.logFiles.length === 0) {
    throw new Error("log-reporter config: 'logFiles' must be a non-empty array");
  }

  for (const lf of parsed.logFiles) {
    if (!lf.path || !lf.name) {
      throw new Error(`log-reporter config: each logFile must have 'path' and 'name', got ${JSON.stringify(lf)}`);
    }
  }

  return {
    scanIntervalMs: parsed.scanIntervalMs ?? 600000,
    bakDir: parsed.bakDir ?? "/tmp/openclaw",
    reportUrl: parsed.reportUrl ?? "",
    logFiles: parsed.logFiles,
  };
}

/**
 * Convert a path with date wildcards into a RegExp that matches the filename part only.
 * Returns { dir, regex } where dir is the directory portion and regex matches filenames.
 */
function pathToPattern(templatePath: string): { dir: string; regex: RegExp } {
  const dir = dirname(templatePath);
  let pattern = basename(templatePath);

  // Escape regex special chars in the literal parts, then replace tokens
  pattern = escapeRegex(pattern);
  for (const [token, replacement] of WILDCARD_TOKENS) {
    pattern = pattern.replaceAll(escapeRegex(token), replacement);
  }

  return { dir, regex: new RegExp(`^${pattern}$`) };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve a path template with date wildcards to actual file paths on disk.
 * Scans the directory and returns all files matching the pattern.
 */
export function resolveLogFiles(templatePath: string): string[] {
  const { dir, regex } = pathToPattern(templatePath);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => regex.test(f))
    .map((f) => join(dir, f))
    .sort(); // chronological order for date-named logs
}

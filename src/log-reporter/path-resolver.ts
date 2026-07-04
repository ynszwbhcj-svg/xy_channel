// Path resolver: resolves file path templates with date wildcards to actual files on disk
import { readdirSync } from "fs";
import { dirname, basename, join } from "path";

// Replace longer tokens first to avoid partial matches
const WILDCARD_TOKENS: [string, string][] = [
  ["{year-month-day}", "\\d{4}-\\d{2}-\\d{2}"],
  ["{year}{month}{day}", "\\d{8}"],
  ["{hour}{minute}{second}", "\\d{6}"],
  ["{year}", "\\d{4}"],
  ["{month}", "\\d{2}"],
  ["{day}", "\\d{2}"],
  ["{hour}", "\\d{2}"],
  ["{minute}", "\\d{2}"],
  ["{second}", "\\d{2}"],
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

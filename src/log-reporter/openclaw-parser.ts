// OpenClaw JSON log line parser
// Inlined from ~/code/openclaw/src/logging/parse-log-line.ts
// Parses tslog JSON log lines into human-readable text format matching "openclaw logs --follow" output

type ParsedLogLine = {
  time?: string;
  level?: string;
  subsystem?: string;
  module?: string;
  message: string;
  raw: string;
};

function trimLower(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function extractMessage(value: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(value)) {
    if (!/^\d+$/.test(key)) continue;
    const item = value[key];
    if (typeof item === "string") {
      parts.push(item);
    } else if (item != null) {
      parts.push(JSON.stringify(item));
    }
  }
  return parts.join(" ");
}

function parseMetaName(raw?: unknown): { subsystem?: string; module?: string } {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      subsystem: typeof parsed.subsystem === "string" ? parsed.subsystem : undefined,
      module: typeof parsed.module === "string" ? parsed.module : undefined,
    };
  } catch {
    return {};
  }
}

/** Parse a single raw JSON log line into structured fields. Returns null for non-JSON lines. */
export function parseLogLine(raw: string): ParsedLogLine | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const meta = parsed["_meta"] as Record<string, unknown> | undefined;
    const nameMeta = parseMetaName(meta?.name);
    const levelRaw = typeof meta?.logLevelName === "string" ? meta.logLevelName : undefined;
    return {
      time:
        typeof parsed.time === "string"
          ? parsed.time
          : typeof meta?.date === "string"
            ? meta.date
            : undefined,
      level: trimLower(levelRaw),
      subsystem: nameMeta.subsystem,
      module: nameMeta.module,
      message: extractMessage(parsed),
      raw,
    };
  } catch {
    return null;
  }
}

/** Format a parsed log line as: "time level subsystem message" (matching openclaw logs output) */
export function formatParsedLogLine(parsed: ParsedLogLine): string {
  const parts: string[] = [];
  if (parsed.time) parts.push(parsed.time);
  if (parsed.level) parts.push(parsed.level.toUpperCase());
  if (parsed.subsystem) parts.push(parsed.subsystem);
  if (parsed.message) parts.push(parsed.message);
  return parts.join(" ");
}

/**
 * Parse and format all lines in a raw log content block.
 * JSON lines are parsed and formatted; non-JSON lines are passed through unchanged.
 */
export function parseAndFormatLogContent(rawContent: string): string {
  const lines = rawContent.split("\n");
  const formatted: string[] = [];
  for (const line of lines) {
    const parsed = parseLogLine(line);
    if (parsed) {
      formatted.push(formatParsedLogLine(parsed));
    } else if (line.length > 0) {
      // Pass through non-JSON, non-empty lines as-is
      formatted.push(line);
    }
  }
  return formatted.join("\n");
}

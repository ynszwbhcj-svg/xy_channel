// Log Reporter Framework
// Self-contained periodic log scanner + uploader + reporter.
// Start via startLogReporter(), stop via stopLogReporter().
import { readFileSync } from "fs";
import { resolveLogFiles } from "./path-resolver.js";
import { scanFile } from "./scanner.js";
import { uploadContent } from "./uploader.js";
import { sendReport } from "./reporter.js";
import { loadCursorStore, saveCursorStore, setCursor } from "./cursor-store.js";
import { parseAndFormatLogContent } from "./openclaw-parser.js";
import type {
  LogReporterOptions,
  LogMonitorConfig,
  CursorStore,
  LogReporterEnv,
  ReportLogFileEntry,
  ReportPayload,
} from "./types.js";
import crypto from "crypto";

// ── Constants ────────────────────────────────────────────────────────────────

const SCAN_INTERVAL_MS = 300000; // 5 minutes
const CURSOR_PATH = "/home/sandbox/.openclaw/.xiaoyilogging/.log-reporter-cursor.json";
const BAK_DIR = "/tmp/openclaw";
const ENV_FILE_PATH = "/home/sandbox/.openclaw/.xiaoyienv";

/** Hardcoded log monitors */
const MONITORS: LogMonitorConfig[] = [
  {
    path: "/tmp/openclaw/openclaw-{year-month-day}.log",
    businessType: "openclaw-gateway",
    jsonParse: true,
  },
  {
    path: "/tmp/openclaw/xiaoyi-channel-{year}{month}{day}.log",
    businessType: "xiaoyi-channel",
    jsonParse: false,
  },
  {
    path: "/home/sandbox/.openclaw/workspace/logs/init_{year}{month}{day}_{hour}{minute}{second}.log",
    businessType: "openclaw-init",
    jsonParse: false,
  },
];

// ── State ────────────────────────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read the .xiaoyienv file and extract required environment variables.
 * Expected format: key=value, one per line. Lines starting with # are comments.
 */
function readEnvFile(): LogReporterEnv {
  let raw: string;
  try {
    raw = readFileSync(ENV_FILE_PATH, "utf-8");
  } catch {
    throw new Error(`Environment file not found: ${ENV_FILE_PATH}`);
  }

  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.substring(0, eqIdx).trim();
    const value = trimmed.substring(eqIdx + 1).trim();
    env[key] = value;
  }

  const required = ["SERVICE_URL", "PERSONAL-API-KEY", "PERSONAL-UID"];
  for (const key of required) {
    if (!env[key]) {
      throw new Error(`Missing required env variable: ${key}`);
    }
  }

  return {
    serviceUrl: env["SERVICE_URL"],
    apiKey: env["PERSONAL-API-KEY"],
    uid: env["PERSONAL-UID"],
  };
}

/** Generate a stable instance ID (UUID) */
function generateInstanceId(): string {
  return crypto.randomUUID();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the log reporter. Runs the first scan immediately, then on a 5-minute interval.
 * Returns a stop function.
 */
export async function startLogReporter(options: LogReporterOptions): Promise<() => void> {
  const env = readEnvFile();
  const instanceId = generateInstanceId();

  console.log(`[log-reporter] Starting with interval ${SCAN_INTERVAL_MS}ms, ${MONITORS.length} monitor(s) configured`);
  console.log(`[log-reporter] Instance ID: ${instanceId}`);

  async function doScan(): Promise<void> {
    if (isRunning) return; // skip if previous scan still running
    isRunning = true;

    try {
      const cursorStore = loadCursorStore(CURSOR_PATH);

      // Accumulated cursors to persist after a successful cycle
      const pendingCursors: Record<string, import("./types.js").FileCursor> = {};

      // Phase 1: Scan all monitors, aggregate content by businessType
      const contentMap = new Map<string, string>();
      const cursorMap = new Map<string, Record<string, import("./types.js").FileCursor>>();

      for (const monitor of MONITORS) {
        const resolvedFiles = resolveLogFiles(monitor.path);
        console.log(
          `[log-reporter] Scanning "${monitor.businessType}": pattern=${monitor.path}, resolved ${resolvedFiles.length} file(s)`,
        );

        const btCursors: Record<string, import("./types.js").FileCursor> = {};
        const btParts: string[] = [];

        for (const filePath of resolvedFiles) {
          try {
            const result = await scanFile(filePath, cursorStore);
            if (!result) continue;

            // Apply JSON parsing for openclaw gateway logs
            const finalContent = monitor.jsonParse
              ? parseAndFormatLogContent(result.content)
              : result.content;

            if (!finalContent) continue;

            btParts.push(finalContent);
            btCursors[filePath] = result.newCursor;
          } catch (err) {
            console.error(`[log-reporter] Error scanning "${filePath}":`, err);
            // Don't persist cursors for this business type on any error
          }
        }

        if (btParts.length > 0) {
          const existing = contentMap.get(monitor.businessType);
          contentMap.set(
            monitor.businessType,
            existing ? existing + "\n" + btParts.join("\n") : btParts.join("\n"),
          );
          cursorMap.set(monitor.businessType, btCursors);
        }
      }

      // Phase 2: Skip if no content at all
      if (contentMap.size === 0) {
        console.log("[log-reporter] No new content across all monitors, skipping report");
        saveCursorStore(CURSOR_PATH, cursorStore);
        return;
      }

      // Phase 3: Upload each business type's content → get URL
      const logFiles: ReportLogFileEntry[] = [];
      for (const [businessType, content] of contentMap) {
        try {
          const url = await uploadContent(content, businessType, BAK_DIR, options.uploadService);
          console.log(`[log-reporter] Uploaded content for "${businessType}", url: ${url}`);
          logFiles.push({ businessType, fileUrl: url });

          // Merge cursors for successful uploads
          const btCursors = cursorMap.get(businessType);
          if (btCursors) {
            for (const [fp, cursor] of Object.entries(btCursors)) {
              pendingCursors[fp] = cursor;
            }
          }
        } catch (err) {
          console.error(`[log-reporter] Upload failed for "${businessType}":`, err);
          // Don't persist cursors for this business type — will retry next cycle
        }
      }

      if (logFiles.length === 0) {
        console.log("[log-reporter] All uploads failed, skipping report");
        return;
      }

      // Phase 4: Send report
      const payload: ReportPayload = { instanceId, logFiles };
      try {
        await sendReport(payload, env);
      } catch (err) {
        console.error("[log-reporter] Report failed:", err);
        // Don't persist cursors on report failure — will retry next cycle
        return;
      }

      // Phase 5: Persist cursors after successful upload + report
      for (const [fp, cursor] of Object.entries(pendingCursors)) {
        setCursor(cursorStore, fp, cursor);
      }
      saveCursorStore(CURSOR_PATH, cursorStore);

    } catch (err) {
      console.error("[log-reporter] Scan failed:", err);
      // Cursor NOT updated — will retry on next cycle
    } finally {
      isRunning = false;
    }
  }

  // Run first scan immediately
  await doScan();

  // Schedule periodic scans
  intervalId = setInterval(doScan, SCAN_INTERVAL_MS);
  intervalId.unref?.();

  return () => stopLogReporter();
}

/**
 * Stop the log reporter timer.
 */
export function stopLogReporter(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[log-reporter] Stopped");
  }
}

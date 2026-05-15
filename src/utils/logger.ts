// Logging utilities for XY channel
// Format: | level | time | sessionId | taskId | msg
import pino from "pino";
import { AsyncLocalStorage } from "async_hooks";
import { mkdirSync, readdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";

// ── Configuration ──
const LOG_DIR = "/tmp/openclaw";
const LOG_PREFIX = "xiaoyi-channel";
const MAX_AGE_DAYS = 30;

// ── UTC+8 helpers ──
function getTodayDateStr(): string {
  const utc8 = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return `${utc8.getUTCFullYear()}${String(utc8.getUTCMonth() + 1).padStart(2, "0")}${String(utc8.getUTCDate()).padStart(2, "0")}`;
}

function formatTimestampUTC8(): string {
  const utc8 = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const y = utc8.getUTCFullYear();
  const M = String(utc8.getUTCMonth() + 1).padStart(2, "0");
  const D = String(utc8.getUTCDate()).padStart(2, "0");
  const h = String(utc8.getUTCHours()).padStart(2, "0");
  const m = String(utc8.getUTCMinutes()).padStart(2, "0");
  const s = String(utc8.getUTCSeconds()).padStart(2, "0");
  return `${y}${M}${D}T${h}${m}${s}`;
}

function getLogFilePath(dateStr?: string): string {
  return join(LOG_DIR, `${LOG_PREFIX}-${dateStr ?? getTodayDateStr()}.log`);
}

// ── Ensure log directory ──
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {}

// ── Cleanup expired logs (older than MAX_AGE_DAYS) ──
function cleanupOldLogs(): void {
  try {
    const files = readdirSync(LOG_DIR);
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    for (const f of files) {
      if (!f.startsWith(LOG_PREFIX) || !f.endsWith(".log")) continue;
      const fp = join(LOG_DIR, f);
      try {
        if (statSync(fp).mtimeMs < cutoff) unlinkSync(fp);
      } catch {}
    }
  } catch {}
}

// Run cleanup on module load
cleanupOldLogs();

// Schedule periodic cleanup every 6 hours
const cleanupTimer = setInterval(cleanupOldLogs, 6 * 60 * 60 * 1000);
cleanupTimer.unref?.();

// ── File destination with daily rotation ──
let currentDate = getTodayDateStr();
const dest = pino.destination({ dest: getLogFilePath(currentDate), sync: false, mkdir: true });

// ── Rotation check ──
function checkRotation(): void {
  const today = getTodayDateStr();
  if (today !== currentDate) {
    currentDate = today;
    dest.reopen(getLogFilePath(today));
    cleanupOldLogs();
  }
}

// ── Session context from globalThis (avoids circular dep with session-manager) ──
function getSessionInfo(): { sessionId: string; taskId: string } {
  try {
    const g = globalThis as Record<string, unknown>;
    // Try AsyncLocalStorage first (correct for concurrent sessions)
    const als = g.__xyAsyncLocalStorage as AsyncLocalStorage<{ sessionId: string; taskId: string }> | undefined;
    if (als) {
      const store = als.getStore();
      if (store?.sessionId) return { sessionId: store.sessionId, taskId: store.taskId ?? "" };
    }
    // Fallback to activeSessions map
    const sessions = g.__xyActiveSessions as Map<string, { sessionId: string; taskId: string }> | undefined;
    if (sessions && sessions.size > 0) {
      const lastKey = g.__xyLastRegisteredSessionKey as string;
      if (lastKey) {
        const entry = sessions.get(lastKey);
        if (entry?.sessionId) return { sessionId: entry.sessionId, taskId: entry.taskId ?? "" };
      }
      const entry = sessions.values().next().value;
      if (entry?.sessionId) return { sessionId: entry.sessionId, taskId: entry.taskId ?? "" };
    }
  } catch {}
  return { sessionId: "", taskId: "" };
}

// ── Core write function ──
function writeLog(level: string, message: string, args: any[]): void {
  checkRotation();
  const { sessionId, taskId } = getSessionInfo();
  const timestamp = formatTimestampUTC8();
  const msg = args.length ? formatMessage(message, args) : message;
  dest.write(`| ${level} | ${timestamp} | ${sessionId} | ${taskId} | ${msg}\n`);
}

// ── Global error handlers (catch-all) ──
process.on("uncaughtException", (err) => {
  writeLog("fatal", "Uncaught exception", [err]);
});

process.on("unhandledRejection", (reason) => {
  writeLog("error", "Unhandled rejection", [reason]);
});

// ── Exported logger ──
export const logger = {
  log(message: string, ...args: any[]): void {
    writeLog("info", message, args);
  },

  warn(message: string, ...args: any[]): void {
    writeLog("warn", message, args);
  },

  error(message: string, ...args: any[]): void {
    writeLog("error", message, args);
  },

  debug(message: string, ...args: any[]): void {
    writeLog("debug", message, args);
  },
};

function formatMessage(message: string, args: any[]): string {
  if (!args.length) return message;
  const suffix = args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) {
        return `${a.name}: ${a.message}\n${a.stack ?? ""}`;
      }
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  return `${message} ${suffix}`;
}

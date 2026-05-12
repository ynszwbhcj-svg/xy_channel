// Pino-based logging utilities for XY channel
import pino from "pino";
import { mkdirSync, readdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";

// ── Configuration ──
const LOG_DIR = "/tmp/openclaw";
const LOG_PREFIX = "xiaoyi-channel";
const MAX_AGE_DAYS = 30;

// ── Daily log file path ──
function getTodayDateStr(): string {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("");
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

// ── Pino instance with daily rotation ──
let currentDate = getTodayDateStr();
const dest = pino.destination({ dest: getLogFilePath(currentDate), sync: false, mkdir: true });
const pinoLogger = pino(
  {
    name: "xiaoyi-channel",
    level: "debug",
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
  },
  dest,
);

// ── Rotation check ──
function checkRotation(): void {
  const today = getTodayDateStr();
  if (today !== currentDate) {
    currentDate = today;
    dest.reopen(getLogFilePath(today));
    cleanupOldLogs();
  }
}

// ── Global error handlers (catch-all) ──
process.on("uncaughtException", (err) => {
  pinoLogger.fatal({ err }, "Uncaught exception");
});

process.on("unhandledRejection", (reason) => {
  pinoLogger.error({ reason }, "Unhandled rejection");
});

// ── Exported logger (same API as before) ──
export const logger = {
  log(message: string, ...args: any[]): void {
    checkRotation();
    const msg = formatMessage(message, args);
    pinoLogger.info(msg);
  },

  warn(message: string, ...args: any[]): void {
    checkRotation();
    const msg = formatMessage(message, args);
    pinoLogger.warn(msg);
  },

  error(message: string, ...args: any[]): void {
    checkRotation();
    const msg = formatMessage(message, args);
    pinoLogger.error(msg);
  },

  debug(message: string, ...args: any[]): void {
    checkRotation();
    const msg = formatMessage(`[DEBUG] ${message}`, args);
    pinoLogger.debug(msg);
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

// Skills usage logger
// Format: |timestamp|skillName|
import { mkdirSync, readdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import pino from "pino";

// ── Configuration ──
const LOG_DIR = "/tmp/openclaw";
const LOG_PREFIX = "skills";
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

/**
 * Write a skill-usage record to the skills log.
 * Format: |YYYYMMDDThhmmss|skillName|
 */
export function writeSkillUsage(skillName: string): void {
  checkRotation();
  const timestamp = formatTimestampUTC8();
  dest.write(`|${timestamp}|${skillName}|\n`);
}

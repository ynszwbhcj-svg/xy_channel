// Cron run logger
// 每次定时任务执行结束（cron_changed action="finished"）写一行。
// Format: |YYYYMMDDThhmmss|{"jobId":...,"name":...,"status":...,"durationMs":...,"runAtMs":...,"nextRunMs":...,"sessionId":...,"model":...}
// 时间戳与主日志/skills 日志统一：UTC+8 的 YYYYMMDDThhmmss。
import { mkdirSync, readdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import pino from "pino";

// ── Configuration ──
const LOG_DIR = "/tmp/openclaw";
const LOG_PREFIX = "cron";
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

/** 一次定时任务执行的日志字段（缺失字段落 null，保持 schema 稳定）。 */
export interface CronRunLogFields {
  jobId: string;
  name: string | null;
  /** 任务创建时间（取自 job 快照 createdAtMs） */
  createdAtMs: number | null;
  /** 当前执行是否成功：ok / error / skipped */
  status: string | null;
  durationMs: number | null;
  runAtMs: number | null;
  nextRunMs: number | null;
  sessionId: string | null;
  model: string | null;
  /** 失败原因；执行成功/无报错时为 null */
  error: string | null;
}

/**
 * Write one cron-run record to the cron log.
 * Format: |YYYYMMDDThhmmss|{json}
 * 写日志失败静默吞掉 —— 绝不影响 cron hook 主链路。
 */
export function writeCronRunLog(fields: CronRunLogFields): void {
  try {
    checkRotation();
    const timestamp = formatTimestampUTC8();
    dest.write(`|${timestamp}|${JSON.stringify(fields)}\n`);
  } catch {}
}

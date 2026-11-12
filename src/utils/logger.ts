// Logging utilities for XY channel
// Format: | level | time | sessionId | taskId | msg
import pino from "pino";
import { AsyncLocalStorage } from "async_hooks";
import { mkdirSync, readdirSync, unlinkSync, statSync, existsSync, renameSync } from "fs";
import { join } from "path";

// ── Configuration ──
const LOG_DIR = "/tmp/openclaw";
const LOG_PREFIX = "xiaoyi-channel";
// 日志最长只保留最近 7 天
const MAX_AGE_DAYS = 7;
// 单个日志文件最大 10MB，超限即切分出带时间戳的备份文件
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// 全部日志文件总量上限 100MB：超过后按 mtime 从最旧的文件开始删
// （正在写入的当天文件不删；Linux 下 unlink 一个打开中的文件会让日志静默丢失）
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
// A2A-OUT 出站帧日志单独成文件（全量 msgDetail 量大，与主日志隔离）
const A2A_LOG_PREFIX = "A2A-OUT";

// ── UTC+8 helpers ──
function formatDateUTC8(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

function getTodayDateStr(): string {
  return formatDateUTC8(new Date(Date.now() + 8 * 60 * 60 * 1000));
}

// 保留窗口起点（UTC+8）：文件名日期早于此日期的删除，即保留今天 + 之前 MAX_AGE_DAYS-1 天
function getCutoffDateStr(): string {
  return formatDateUTC8(new Date(Date.now() + 8 * 60 * 60 * 1000 - (MAX_AGE_DAYS - 1) * 24 * 60 * 60 * 1000));
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

function getA2ALogFilePath(dateStr?: string): string {
  return join(LOG_DIR, `${A2A_LOG_PREFIX}-${dateStr ?? getTodayDateStr()}.log`);
}

// ── Ensure log directory ──
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {}

// ── Cleanup expired logs (older than MAX_AGE_DAYS) ──
// 按文件名里的日期判断（xiaoyi-channel-YYYYMMDD...，UTC+8，与生成时一致）：
// 日期早于 getCutoffDateStr() 的删除。文件名解析不出日期的文件不动它。
function cleanupOldLogs(): void {
  try {
    const files = readdirSync(LOG_DIR);
    const cutoffStr = getCutoffDateStr();
    const dateRe = new RegExp(`^(?:${LOG_PREFIX}|${A2A_LOG_PREFIX})-(\\d{8})`);
    for (const f of files) {
      if (!(f.startsWith(LOG_PREFIX) || f.startsWith(A2A_LOG_PREFIX)) || !f.endsWith(".log")) continue;
      const m = dateRe.exec(f);
      if (!m) continue;
      if (m[1] < cutoffStr) {
        try {
          unlinkSync(join(LOG_DIR, f));
        } catch {}
      }
    }
  } catch {}
  enforceTotalCap();
}

// ── Enforce total size cap ──
// 所有 xiaoyi-channel-*.log / A2A-OUT-*.log 加起来超过 MAX_TOTAL_BYTES 时，
// 按 mtime 从最旧的文件开始删，直到回到上限以内。正在写入的当天文件永不删除
// （否则会静默丢日志）。
function enforceTotalCap(): void {
  try {
    const activePaths = new Set([getLogFilePath(currentDate), getA2ALogFilePath(currentDate)]);
    const files: { fp: string; size: number; mtimeMs: number }[] = [];
    for (const f of readdirSync(LOG_DIR)) {
      if (!(f.startsWith(LOG_PREFIX) || f.startsWith(A2A_LOG_PREFIX)) || !f.endsWith(".log")) continue;
      const fp = join(LOG_DIR, f);
      try {
        const st = statSync(fp);
        files.push({ fp, size: st.size, mtimeMs: st.mtimeMs });
      } catch {}
    }
    let total = files.reduce((sum, f) => sum + f.size, 0);
    if (total <= MAX_TOTAL_BYTES) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of files) {
      if (total <= MAX_TOTAL_BYTES) break;
      if (activePaths.has(f.fp)) continue;
      try {
        unlinkSync(f.fp);
        total -= f.size;
      } catch {}
    }
  } catch {}
}

// ── File destination with daily rotation ──
let currentDate = getTodayDateStr();
const dest = pino.destination({ dest: getLogFilePath(currentDate), sync: false, mkdir: true });

// Run cleanup on module load（放在 currentDate 声明之后，enforceTotalCap 依赖它）
cleanupOldLogs();

// Schedule periodic cleanup every 6 hours
const cleanupTimer = setInterval(cleanupOldLogs, 6 * 60 * 60 * 1000);
cleanupTimer.unref?.();

// ── Current file size tracking (for MAX_FILE_BYTES cap) ──
// 进程启动时从现有文件初始化，随后按写入行字节数累加，避免每次写日志都 statSync。
let currentFileBytes = 0;
try {
  currentFileBytes = statSync(getLogFilePath(currentDate)).size;
} catch {}

// 当前文件超过 MAX_FILE_BYTES：重命名为带时间戳的备份文件后重开新文件。
// 备份文件名仍以 xiaoyi-channel 开头、.log 结尾，随 cleanupOldLogs 按 7 天 /
// MAX_TOTAL_BYTES 总量上限统一清理。
function rotateForSize(): void {
  try {
    const currentPath = getLogFilePath(currentDate);
    let backupPath = join(LOG_DIR, `${LOG_PREFIX}-${formatTimestampUTC8()}.log`);
    if (existsSync(backupPath)) {
      backupPath = join(LOG_DIR, `${LOG_PREFIX}-${formatTimestampUTC8()}-${Date.now()}.log`);
    }
    renameSync(currentPath, backupPath);
    dest.reopen(currentPath);
  } catch {}
  currentFileBytes = 0;
  // 切分出备份文件后总量可能超限，立刻按总量上限回收最旧文件
  enforceTotalCap();
}

// A2A-OUT 独立文件目的地（按日轮转；纳入 cleanupOldLogs / enforceTotalCap 治理）
const a2aDest = pino.destination({ dest: getA2ALogFilePath(currentDate), sync: false, mkdir: true });

// ── Rotation check ──
function checkRotation(): void {
  const today = getTodayDateStr();
  if (today !== currentDate) {
    currentDate = today;
    dest.reopen(getLogFilePath(today));
    a2aDest.reopen(getA2ALogFilePath(today));
    currentFileBytes = 0;
    cleanupOldLogs();
    return;
  }
  if (currentFileBytes >= MAX_FILE_BYTES) {
    rotateForSize();
  }
}

// ── Session context from globalThis (avoids circular dep with session-manager) ──
// Pure ALS: the global Map fallback was removed when session-manager switched
// to AsyncLocalStorage-only. Outside a runWithSessionContext scope (cron,
// startup), getSessionInfo returns empty strings.
function getSessionInfo(): { sessionId: string; taskId: string } {
  try {
    const g = globalThis as Record<string, unknown>;
    const als = g.__xyAsyncLocalStorage as AsyncLocalStorage<{ sessionId: string; taskId: string }> | undefined;
    if (als) {
      const store = als.getStore();
      if (store?.sessionId) return { sessionId: store.sessionId, taskId: store.taskId ?? "" };
    }
  } catch {}
  return { sessionId: "", taskId: "" };
}

// ── Global error handlers (catch-all) ──
process.on("uncaughtException", (err) => {
  writeLog("fatal", "Uncaught exception", [err]);
});

process.on("unhandledRejection", (reason) => {
  writeLog("error", "Unhandled rejection", [reason]);
});

// ── Core write function with optional explicit context ──
function writeLog(level: string, message: string, args: any[], explicitSid?: string, explicitTid?: string): void {
  checkRotation();
  const sessionId = explicitSid !== undefined ? explicitSid : getSessionInfo().sessionId;
  const taskId = explicitTid !== undefined ? explicitTid : getSessionInfo().taskId;
  const timestamp = formatTimestampUTC8();
  const msg = args.length ? formatMessage(message, args) : message;
  const line = `|${level}|${timestamp}|${sessionId}|${taskId}|${msg}\n`;
  // [A2A-OUT] 标签的日志单独路由到 A2A-OUT-YYYYMMDD.log（不进主日志；
  // 不计入主日志的单文件大小切分，仅受 7 天保留与总量上限治理）
  if (msg.startsWith("[A2A-OUT]")) {
    a2aDest.write(line);
    return;
  }
  currentFileBytes += Buffer.byteLength(line, "utf8");
  dest.write(line);
}

export interface ScopedLogger {
  log(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
  debug(message: string, ...args: any[]): void;
}

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

  /** Create a scoped logger with explicit sessionId/taskId (bypasses AsyncLocalStorage/globalThis). */
  withContext(sessionId: string, taskId: string): ScopedLogger {
    return {
      log(message: string, ...args: any[]): void { writeLog("info", message, args, sessionId, taskId); },
      warn(message: string, ...args: any[]): void { writeLog("warn", message, args, sessionId, taskId); },
      error(message: string, ...args: any[]): void { writeLog("error", message, args, sessionId, taskId); },
      debug(message: string, ...args: any[]): void { writeLog("debug", message, args, sessionId, taskId); },
    };
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

// Skills usage logger
// Format: |timestamp|skillName|
//
// 另含 read 工具读技能 md 的打点支持：
//  - 读技能顶层 SKILL.md：不立即写，先记入 pending（markSkillMdRead）；同会话
//    随后 exec/bash 命中该技能路径、或读该技能内其它 md 文件时丢弃
//    （suppressPendingSkillMdRead，实际使用会各自打点，避免重复）；否则由
//    turn 结束信号（agent_end / run lifecycle end / session_end）或
//    TTL 到期兜底落盘（flushPendingSkillMdReads），计一次「查看技能」使用。
//  - 读技能内除顶层 SKILL.md 外的其它 md：调用方每次 read 直接 writeSkillUsage
//    打点，并 suppress 同技能 pending。
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

// ── read 工具读技能 md 的路径分类 ──

/**
 * read 工具路径分类（技能 md 打点用）：
 *  - skillMd：.../skills/<name>/SKILL.md（含 core_skills，仅顶层；与
 *    step-info-tool 的 SKILL.md 提取正则一致）
 *  - otherSkillMd：技能目录内（含子目录）除顶层 SKILL.md 外的其它 .md 文件
 *  - null：非技能 md 路径
 */
export function classifySkillMdReadPath(
  path: unknown,
): { kind: "skillMd" | "otherSkillMd"; skillName: string } | null {
  if (typeof path !== "string" || path.trim().length === 0) return null;
  const normalized = path.replace(/\\/g, "/");
  const skillMd = normalized.match(/(?:core_)?skills\/([^/'"\s;&|]+)\/SKILL\.md(?:$|[\s?'"])/i);
  if (skillMd) return { kind: "skillMd", skillName: skillMd[1] };
  const otherMd = normalized.match(
    /(?:^|[/\s"';&|])(?:core_)?skills\/([^/'"\s;&|]+)\/[^\s"';&|]*?\.md(?:$|[\s"';&|?])/i,
  );
  if (otherMd) return { kind: "otherSkillMd", skillName: otherMd[1] };
  return null;
}

// ── SKILL.md 读取的延迟打点（pending） ──

/** pending 兜底落盘时限：正常路径由 turn 结束信号 flush，TTL 仅兜底（如
 *  run 异常结束无 lifecycle end 信号）。 */
const PENDING_SKILL_MD_READ_TTL_MS = 10 * 60 * 1000;

interface PendingSkillMdRead {
  count: number;
  skillName: string;
  timer: ReturnType<typeof setTimeout>;
}

/** key = `${sessionKey}|${skillName.toLowerCase()}`（skillName 由正则提取，不含 "|"）。 */
const pendingSkillMdReads = new Map<string, PendingSkillMdRead>();

function pendingKey(sessionKey: string, skillName: string): string {
  return `${sessionKey}|${skillName.toLowerCase()}`;
}

function armFlushTimer(key: string): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => flushPendingEntry(key), PENDING_SKILL_MD_READ_TTL_MS);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

function flushPendingEntry(key: string): void {
  const entry = pendingSkillMdReads.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingSkillMdReads.delete(key);
  for (let i = 0; i < entry.count; i++) {
    writeSkillUsage(entry.skillName);
  }
}

/** read 工具读到技能顶层 SKILL.md：登记一次待打点（延迟，可被后续实际使用抑制）。
 *  同会话同技能重复读：计数累加并刷新 TTL。 */
export function markSkillMdRead(sessionKey: string, skillName: string): void {
  const key = pendingKey(sessionKey, skillName);
  const existing = pendingSkillMdReads.get(key);
  if (existing) {
    existing.count += 1;
    clearTimeout(existing.timer);
    existing.timer = armFlushTimer(key);
    return;
  }
  pendingSkillMdReads.set(key, { count: 1, skillName, timer: armFlushTimer(key) });
}

/** 同会话同技能发生实际使用（exec/bash 命中技能路径 / 读技能内其它 md）：
 *  丢弃该技能全部待打点的 SKILL.md 阅读记录。无 pending 时为 no-op。 */
export function suppressPendingSkillMdRead(sessionKey: string, skillName: string): void {
  const key = pendingKey(sessionKey, skillName);
  const entry = pendingSkillMdReads.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingSkillMdReads.delete(key);
}

/**
 * 落盘待打点：传 sessionKey 仅 flush 该会话，省略则全量 flush。
 * 调用时机：agent_end / run lifecycle end（按 sessionKey）、session_end、
 * gateway_stop（全量）。重复调用幂等（已 flush 的 key 不存在，no-op）。
 */
export function flushPendingSkillMdReads(sessionKey?: string): void {
  for (const key of [...pendingSkillMdReads.keys()]) {
    if (sessionKey !== undefined && !key.startsWith(`${sessionKey}|`)) continue;
    flushPendingEntry(key);
  }
}

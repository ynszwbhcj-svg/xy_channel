// Cron job ↔ convId 持久化映射
//
// 背景：cron 定时任务执行完成下发时（push 的 kind="data" 携带 cronId），客户端
// 需要一个与 cronId 一一对应的会话标识 convId。本文件按真实 cronId 保存 convId，
// 首次下发时无映射则随机生成一个 16 位 convId 并落盘，之后同一 cronId 复用；
// 收到 AgentEvent.UpdateTaskConvId 事件时强制轮换为新 convId。
//
// 存储位置与 cron-push-map.json 同目录：/home/sandbox/.openclaw/cron-conv-map.json
import { promises as fs } from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { logger } from "./logger.js";
import { withAsyncLock } from "./async-mutex.js";

const CRON_CONV_MAP_FILE = "/home/sandbox/.openclaw/cron-conv-map.json";

export interface CronConvMapEntry {
  convId: string;
  createdAt: number;
  /** 最近一次轮换时间（首次创建时与 createdAt 相同）。 */
  updatedAt: number;
}

export interface CronConvMapFile {
  version: 1;
  entries: Record<string, CronConvMapEntry>;
}

/** 生成 16 位随机 convId（8 字节随机数的 hex 编码，恰 16 个字符）。 */
export function generateConvId(): string {
  return randomBytes(8).toString("hex");
}

async function ensureDirectoryExists(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    logger.error(`[CronConvMap] Failed to create directory ${dir}:`, error);
  }
}

async function readMap(): Promise<CronConvMapFile> {
  try {
    await ensureDirectoryExists(CRON_CONV_MAP_FILE);
    const content = await fs.readFile(CRON_CONV_MAP_FILE, "utf-8");
    const parsed = JSON.parse(content);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === 1 &&
      parsed.entries &&
      typeof parsed.entries === "object"
    ) {
      return parsed as CronConvMapFile;
    }
    logger.warn(`[CronConvMap] Unexpected file shape, returning empty map`);
    return { version: 1, entries: {} };
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return { version: 1, entries: {} };
    }
    logger.error(`[CronConvMap] Failed to read map:`, error);
    return { version: 1, entries: {} };
  }
}

async function writeMap(map: CronConvMapFile): Promise<void> {
  try {
    await ensureDirectoryExists(CRON_CONV_MAP_FILE);
    await fs.writeFile(CRON_CONV_MAP_FILE, JSON.stringify(map, null, 2), "utf-8");
  } catch (error) {
    logger.error(`[CronConvMap] Failed to write map:`, error);
    throw error;
  }
}

/**
 * 按 cronId 取 convId：已有映射直接返回；无映射则生成 16 位随机 convId
 * 并持久化（首次建立映射）。失败时返回 null，不抛出，避免阻塞 push 主流程。
 */
export async function getOrCreateConvId(cronId: string): Promise<string | null> {
  if (!cronId || typeof cronId !== "string") {
    logger.warn(`[CronConvMap] Invalid cronId: ${cronId}`);
    return null;
  }
  try {
    // 读→改→写 整体加互斥锁，防并发写覆盖丢映射。
    return await withAsyncLock(async () => {
      const map = await readMap();
      const existing = map.entries[cronId];
      if (existing?.convId) {
        return existing.convId;
      }
      const convId = generateConvId();
      const now = Date.now();
      map.entries[cronId] = { convId, createdAt: now, updatedAt: now };
      await writeMap(map);
      logger.log(`[CronConvMap] Created convId for cronId=${cronId}`);
      return convId;
    });
  } catch (error) {
    logger.error(`[CronConvMap] Failed to getOrCreateConvId:`, error);
    return null;
  }
}

/**
 * 强制轮换 convId（UpdateTaskConvId 事件）：无论原映射是否存在，
 * 都生成一个新的 16 位 convId 覆盖旧映射并持久化。
 * 失败时返回 null，不抛出，避免影响事件响应。
 */
export async function regenerateConvId(cronId: string): Promise<string | null> {
  if (!cronId || typeof cronId !== "string") {
    logger.warn(`[CronConvMap] Invalid cronId: ${cronId}`);
    return null;
  }
  try {
    return await withAsyncLock(async () => {
      const map = await readMap();
      const convId = generateConvId();
      const now = Date.now();
      const createdAt = map.entries[cronId]?.createdAt ?? now;
      map.entries[cronId] = { convId, createdAt, updatedAt: now };
      await writeMap(map);
      logger.log(`[CronConvMap] Regenerated convId for cronId=${cronId}`);
      return convId;
    });
  } catch (error) {
    logger.error(`[CronConvMap] Failed to regenerateConvId:`, error);
    return null;
  }
}

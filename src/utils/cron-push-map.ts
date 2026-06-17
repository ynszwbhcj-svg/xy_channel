// Cron job ↔ pushId 持久化映射
//
// 背景：cron 定时任务触发时，工具调用走 push 通道（sendCommandViaPush），
// 需要正确的 pushId 才能推到"创建该任务的那台设备"。pushIdList.json 是
// 扁平去重数组，无法区分设备；本文件按真实 jobId 保存创建时的 pushId，
// fire 时通过 jobId 反查即可定位到正确设备。
//
// jobId 的两端来源（均为真实 jobId，无需规范化反解）：
//   - 写入：after_tool_call 拦 cron/add → event.result.id；
//           cron-query-handler inline → result.id
//   - 读取：provider.ts extractCronUuid(context.messages) → "[cron:<jobId> ...]"
import { promises as fs } from "fs";
import * as path from "path";
import { logger } from "./logger.js";

const CRON_PUSH_MAP_FILE = "/home/sandbox/.openclaw/cron-push-map.json";

/** 映射来源，区分两种创建路径。 */
export type CronPushMapSource = "conversation" | "cron-query";

export interface CronPushMapEntry {
  pushId: string;
  /** 创建该 cron 时的 xy sessionId，便于同进程兜底。 */
  sessionId?: string;
  /** 冗余记录设备类型，fire 时可按设备类型做差异化处理。 */
  deviceType?: string;
  source?: CronPushMapSource;
  createdAt: number;
}

export interface CronPushMapFile {
  version: 1;
  entries: Record<string, CronPushMapEntry>;
}

async function ensureDirectoryExists(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    logger.error(`[CronPushMap] Failed to create directory ${dir}:`, error);
  }
}

async function readMap(): Promise<CronPushMapFile> {
  try {
    await ensureDirectoryExists(CRON_PUSH_MAP_FILE);
    const content = await fs.readFile(CRON_PUSH_MAP_FILE, "utf-8");
    const parsed = JSON.parse(content);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === 1 &&
      parsed.entries &&
      typeof parsed.entries === "object"
    ) {
      return parsed as CronPushMapFile;
    }
    logger.warn(`[CronPushMap] Unexpected file shape, returning empty map`);
    return { version: 1, entries: {} };
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return { version: 1, entries: {} };
    }
    logger.error(`[CronPushMap] Failed to read map:`, error);
    return { version: 1, entries: {} };
  }
}

async function writeMap(map: CronPushMapFile): Promise<void> {
  try {
    await ensureDirectoryExists(CRON_PUSH_MAP_FILE);
    await fs.writeFile(CRON_PUSH_MAP_FILE, JSON.stringify(map, null, 2), "utf-8");
  } catch (error) {
    logger.error(`[CronPushMap] Failed to write map:`, error);
    throw error;
  }
}

/** 写入/更新一条 jobId → pushId 映射。 */
export async function setJobPushId(
  jobId: string,
  entry: Omit<CronPushMapEntry, "createdAt">,
): Promise<void> {
  if (!jobId || typeof jobId !== "string") {
    logger.warn(`[CronPushMap] Invalid jobId: ${jobId}`);
    return;
  }
  if (!entry.pushId || typeof entry.pushId !== "string") {
    logger.warn(`[CronPushMap] Skipping setJobPushId: missing pushId for jobId=${jobId}`);
    return;
  }
  try {
    const map = await readMap();
    map.entries[jobId] = { ...entry, createdAt: Date.now() };
    await writeMap(map);
    logger.log(
      `[CronPushMap] Saved jobId=${jobId}, source=${entry.source ?? "?"}, pushId=${entry.pushId.substring(0, 20)}...`,
    );
  } catch (error) {
    logger.error(`[CronPushMap] Failed to setJobPushId:`, error);
    // 不抛出，避免影响主流程
  }
}

/** fire 时主查询：按 jobId 取 pushId。 */
export async function getPushIdByJobId(
  jobId: string,
): Promise<{ pushId: string; entry: CronPushMapEntry } | null> {
  if (!jobId) return null;
  try {
    const map = await readMap();
    const entry = map.entries[jobId];
    if (entry && entry.pushId) {
      return { pushId: entry.pushId, entry };
    }
    return null;
  } catch (error) {
    logger.error(`[CronPushMap] Failed to getPushIdByJobId:`, error);
    return null;
  }
}

/** 删除一条映射（cron job 被移除时清理）。 */
export async function removeJob(jobId: string): Promise<void> {
  if (!jobId) return;
  try {
    const map = await readMap();
    if (map.entries[jobId]) {
      delete map.entries[jobId];
      await writeMap(map);
      logger.log(`[CronPushMap] Removed jobId=${jobId}`);
    }
  } catch (error) {
    logger.error(`[CronPushMap] Failed to removeJob:`, error);
  }
}

/** 对账：删除 openclaw 里已不存在的 job，避免映射无限增长。 */
export async function pruneStale(existingJobIds: Set<string>): Promise<void> {
  try {
    const map = await readMap();
    let removed = 0;
    for (const key of Object.keys(map.entries)) {
      if (!existingJobIds.has(key)) {
        delete map.entries[key];
        removed++;
      }
    }
    if (removed > 0) {
      await writeMap(map);
      logger.log(`[CronPushMap] Pruned ${removed} stale entries`);
    }
  } catch (error) {
    logger.error(`[CronPushMap] Failed to pruneStale:`, error);
  }
}

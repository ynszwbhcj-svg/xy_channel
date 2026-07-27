// pushData 持久化管理器
import { promises as fs } from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { logger } from "./logger.js";

const PUSHDATA_FILE = "/home/sandbox/.openclaw/pushData.json";
const MAX_PUSHDATA_ITEMS = 1000; // 最多保留 1000 条记录

/**
 * 推送数据项
 */
export interface PushDataItem {
  pushDataId: string;
  dataDetail: string;
  time: string; // 格式：YYYYMMDD HHmmss（北京时间）
  /** cron 推送时携带：任务 jobId（正常对话推送无此字段） */
  cronJobId?: string;
  /** cron 推送时携带：任务标题（openclaw job.name） */
  cronTitle?: string;
}

/**
 * 格式化北京时间（UTC+8）
 */
function formatBeijingTime(date: Date): string {
  // 转换为北京时间（UTC+8）
  const beijingTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const iso = beijingTime.toISOString(); // 2024-03-22T10:30:45.123Z

  // 转换为 YYYYMMDD HHmmss 格式
  return iso
    .replace(/T/, ' ')
    .replace(/\.\d+Z$/, '')
    .replace(/-/g, '')
    .replace(/:/g, '')
    .substring(0, 15); // 取前15个字符：YYYYMMDD HHmmss
}

/**
 * 确保目录存在
 */
async function ensureDirectoryExists(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    logger.error(`[PushDataManager] Failed to create directory ${dir}:`, error);
  }
}

/**
 * 读取 pushData 列表
 */
async function readPushDataList(): Promise<PushDataItem[]> {
  try {
    await ensureDirectoryExists(PUSHDATA_FILE);
    const content = await fs.readFile(PUSHDATA_FILE, "utf-8");
    const list = JSON.parse(content);
    if (!Array.isArray(list)) {
      logger.warn(`[PushDataManager] pushData.json is not an array, returning empty array`);
      return [];
    }
    return list;
  } catch (error: any) {
    if (error.code === "ENOENT") {
      // 文件不存在，返回空数组
      return [];
    }
    logger.error(`[PushDataManager] Failed to read pushData:`, error);
    return [];
  }
}

/**
 * 写入 pushData 列表
 */
async function writePushDataList(list: PushDataItem[]): Promise<void> {
  try {
    await ensureDirectoryExists(PUSHDATA_FILE);

    // 限制数据条数，保留最近的 MAX_PUSHDATA_ITEMS 条
    const limitedList = list.slice(-MAX_PUSHDATA_ITEMS);

    await fs.writeFile(PUSHDATA_FILE, JSON.stringify(limitedList, null, 2), "utf-8");

    if (list.length > MAX_PUSHDATA_ITEMS) {
      logger.log(`[PushDataManager] Trimmed pushData list from ${list.length} to ${limitedList.length} items`);
    }
  } catch (error) {
    logger.error(`[PushDataManager] Failed to write pushData:`, error);
    throw error;
  }
}

/**
 * 保存推送数据，返回 pushDataId
 * meta.cronJobId/cronTitle 仅 cron 推送时传入（正常对话为 undefined，不写入文件）。
 */
export async function savePushData(
  dataDetail: string,
  meta?: { cronJobId?: string; cronTitle?: string }
): Promise<string> {
  const pushDataId = randomUUID();
  const time = formatBeijingTime(new Date());

  const item: PushDataItem = {
    pushDataId,
    dataDetail,
    time,
    ...(meta?.cronJobId ? { cronJobId: meta.cronJobId } : {}),
    ...(meta?.cronTitle ? { cronTitle: meta.cronTitle } : {}),
  };

  try {
    const list = await readPushDataList();
    list.push(item);
    await writePushDataList(list);

    logger.log(`[PushDataManager] Saved pushData: id=${pushDataId}, time=${time}, dataLength=${dataDetail.length}, totalItems=${list.length}`);

    return pushDataId;
  } catch (error) {
    logger.error(`[PushDataManager] Failed to save pushData:`, error);
    throw error;
  }
}

/**
 * 根据 pushDataId 获取推送数据
 */
export async function getPushDataById(pushDataId: string): Promise<PushDataItem | null> {
  try {
    const list = await readPushDataList();
    const item = list.find((item) => item.pushDataId === pushDataId);

    if (item) {
      logger.log(`[PushDataManager] Found pushData: ${pushDataId}`);
    } else {
      logger.warn(`[PushDataManager] pushData not found: ${pushDataId}`);
    }

    return item || null;
  } catch (error) {
    logger.error(`[PushDataManager] Failed to get pushData by id:`, error);
    return null;
  }
}

/**
 * 搜索推送数据（支持关键词模糊匹配）
 */
export async function searchPushData(keywords?: string): Promise<PushDataItem[]> {
  try {
    const list = await readPushDataList();

    if (!keywords || keywords.trim() === "") {
      // 无关键词，返回所有数据
      logger.log(`[PushDataManager] Search with no keywords, returning all ${list.length} items`);
      return list;
    }

    // 关键词模糊匹配（在 dataDetail 和 pushDataId 中搜索）
    const lowerKeywords = keywords.toLowerCase();
    const results = list.filter(
      (item) =>
        item.dataDetail.toLowerCase().includes(lowerKeywords) ||
        item.pushDataId.toLowerCase().includes(lowerKeywords)
    );

    logger.log(`[PushDataManager] Search with keywords "${keywords}": found ${results.length} items`);
    return results;
  } catch (error) {
    logger.error(`[PushDataManager] Failed to search pushData:`, error);
    return [];
  }
}

/**
 * 获取所有推送数据
 */
export async function getAllPushData(): Promise<PushDataItem[]> {
  try {
    const list = await readPushDataList();
    logger.log(`[PushDataManager] Retrieved ${list.length} pushData items`);
    return list;
  } catch (error) {
    logger.error(`[PushDataManager] Failed to get all pushData:`, error);
    return [];
  }
}

/**
 * 清空所有推送数据（用于测试或重置）
 */
export async function clearAllPushData(): Promise<void> {
  try {
    await writePushDataList([]);
    logger.log(`[PushDataManager] Cleared all pushData`);
  } catch (error) {
    logger.error(`[PushDataManager] Failed to clear pushData:`, error);
  }
}

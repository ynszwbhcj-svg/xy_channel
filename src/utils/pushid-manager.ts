// pushId 持久化管理器
import { promises as fs } from "fs";
import * as path from "path";
import { logger } from "./logger.js";

const PUSHID_LIST_FILE = "/home/sandbox/.openclaw/pushIdList.json";

/**
 * 确保目录存在
 */
async function ensureDirectoryExists(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    logger.error(`[PushIdManager] Failed to create directory ${dir}:`, error);
  }
}

/**
 * 读取 pushId 列表
 */
async function readPushIdList(): Promise<string[]> {
  try {
    await ensureDirectoryExists(PUSHID_LIST_FILE);
    const content = await fs.readFile(PUSHID_LIST_FILE, "utf-8");
    const list = JSON.parse(content);
    if (!Array.isArray(list)) {
      logger.warn(`[PushIdManager] pushIdList.json is not an array, returning empty array`);
      return [];
    }
    return list;
  } catch (error: any) {
    if (error.code === "ENOENT") {
      // 文件不存在，返回空数组
      return [];
    }
    logger.error(`[PushIdManager] Failed to read pushIdList:`, error);
    return [];
  }
}

/**
 * 写入 pushId 列表
 */
async function writePushIdList(list: string[]): Promise<void> {
  try {
    await ensureDirectoryExists(PUSHID_LIST_FILE);
    await fs.writeFile(PUSHID_LIST_FILE, JSON.stringify(list, null, 2), "utf-8");
  } catch (error) {
    logger.error(`[PushIdManager] Failed to write pushIdList:`, error);
    throw error;
  }
}

/**
 * 添加新的 pushId（去重）
 */
export async function addPushId(pushId: string): Promise<void> {
  if (!pushId || typeof pushId !== "string") {
    logger.warn(`[PushIdManager] Invalid pushId: ${pushId}`);
    return;
  }

  try {
    const list = await readPushIdList();

    // 检查是否已存在
    if (list.includes(pushId)) {
      logger.log(`[PushIdManager] pushId already exists: ${pushId.substring(0, 20)}...`);
      return;
    }

    // 添加新 pushId
    list.push(pushId);
    await writePushIdList(list);

    logger.log(`[PushIdManager] Added new pushId: ${pushId.substring(0, 20)}, total=${list.length}`);
  } catch (error) {
    logger.error(`[PushIdManager] Failed to add pushId:`, error);
    // 不抛出异常，避免影响主流程
  }
}

/**
 * 获取所有 pushId
 */
export async function getAllPushIds(): Promise<string[]> {
  try {
    const list = await readPushIdList();
    logger.log(`[PushIdManager] Retrieved ${list.length} pushIds`);
    return list;
  } catch (error) {
    logger.error(`[PushIdManager] Failed to get all pushIds:`, error);
    return [];
  }
}

/**
 * 清空所有 pushId（用于测试或重置）
 */
export async function clearAllPushIds(): Promise<void> {
  try {
    await writePushIdList([]);
    logger.log(`[PushIdManager] Cleared all pushIds`);
  } catch (error) {
    logger.error(`[PushIdManager] Failed to clear pushIds:`, error);
  }
}

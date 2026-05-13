// xiaoyi runtime 持久化管理器
import { promises as fs } from "fs";
import * as path from "path";
import { logger } from "./logger.js";

const RUNTIME_FILE = "/home/sandbox/.openclaw/.xiaoyiruntime";

/**
 * 确保目录存在
 */
async function ensureDirectoryExists(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    logger.error(`[RuntimeManager] Failed to create directory ${dir}:`, error);
  }
}

/**
 * 保存 runtime 信息到 .xiaoyiruntime 文件
 * @param webSocketSessionId - WebSocket 层级的 sessionId (SESSION_ID)
 * @param conversationId - param 里的 sessionId (CONVERSATION_ID)
 * @param taskId - 任务 ID (param.id)
 */
export async function saveRuntimeInfo(
  webSocketSessionId: string,
  conversationId: string,
  taskId: string
): Promise<void> {
  if (!webSocketSessionId || !conversationId || !taskId) {
    logger.warn(`[RuntimeManager] Invalid params: SESSION_ID=${webSocketSessionId}, CONVERSATION_ID=${conversationId}, TASK_ID=${taskId}`);
    return;
  }

  try {
    await ensureDirectoryExists(RUNTIME_FILE);

    const updates: Record<string, string> = {
      SESSION_ID: webSocketSessionId,
      CONVERSATION_ID: conversationId,
      TASK_ID: taskId,
    };

    let lines: string[] = [];
    try {
      const content = await fs.readFile(RUNTIME_FILE, "utf-8");
      lines = content.split("\n");
    } catch {
      // File doesn't exist yet
    }

    for (const [key, value] of Object.entries(updates)) {
      const index = lines.findIndex((line) => line.startsWith(`${key}=`));
      if (index !== -1) {
        lines[index] = `${key}=${value}`;
      } else {
        lines.push(`${key}=${value}`);
      }
    }

    const result = lines.filter((line) => line.trim() !== "").join("\n") + "\n";
    await fs.writeFile(RUNTIME_FILE, result, "utf-8");

    logger.log(`[RuntimeManager] ✅ Saved runtime info to .xiaoyiruntime`);
    logger.log(`[RuntimeManager]   - SESSION_ID: ${webSocketSessionId}`);
    logger.log(`[RuntimeManager]   - CONVERSATION_ID: ${conversationId}`);
    logger.log(`[RuntimeManager]   - TASK_ID: ${taskId}`);
  } catch (error) {
    logger.error(`[RuntimeManager] Failed to save runtime info:`, error);
    // 不抛出异常，避免影响主流程
  }
}

// TaskId Manager - 管理session级别的活跃taskId
// 用于 monitor.ts 检测活跃任务（决定是否并发执行steer消息）
import { logger } from "./utils/logger.js";

interface TaskIdBinding {
  sessionId: string;
  currentTaskId: string;
  currentMessageId: string;
  updatedAt: number;
}

/**
 * Session到活跃TaskId的映射
 * Key: sessionId
 * Value: TaskIdBinding
 * Uses globalThis to ensure a single Map across all module copies.
 */
const _g = globalThis as Record<string, unknown>;
if (!_g.__xyActiveTaskIds) {
  _g.__xyActiveTaskIds = new Map<string, TaskIdBinding>();
}
const activeTaskIds = _g.__xyActiveTaskIds as Map<string, TaskIdBinding>;

/**
 * 注册或更新session的活跃taskId。
 * Returns true if this was an update (session already had an active task).
 */
export function registerTaskId(
  sessionId: string,
  taskId: string,
  messageId: string,
): boolean {
  const existing = activeTaskIds.get(sessionId);

  if (existing) {
    logger.log(`[TASK_MANAGER] Updating taskId: ${existing.currentTaskId} → ${taskId}`);
    existing.currentTaskId = taskId;
    existing.currentMessageId = messageId;
    existing.updatedAt = Date.now();
    return true; // isUpdate
  } else {
    activeTaskIds.set(sessionId, {
      sessionId,
      currentTaskId: taskId,
      currentMessageId: messageId,
      updatedAt: Date.now(),
    });
    logger.log(`[TASK_MANAGER] Registered new taskId: ${taskId}`);
    return false;
  }
}

/**
 * 移除session的活跃taskId（消息处理完成时调用）。
 */
export function decrementTaskIdRef(sessionId: string): void {
  logger.log(`[TASK_MANAGER] Removing taskId`);
  activeTaskIds.delete(sessionId);
}

/**
 * 检查session是否有活跃的taskId
 */
export function hasActiveTask(sessionId: string): boolean {
  return activeTaskIds.has(sessionId);
}

/**
 * 获取所有活跃的 task bindings（用于 gateway_stop 通知等场景）
 */
export function getAllActiveTaskBindings(): TaskIdBinding[] {
  return Array.from(activeTaskIds.values());
}

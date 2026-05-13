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
  logger.log(`[TASK_MANAGER] 📝 Registering/Updating taskId for session: ${sessionId}`);
  logger.log(`[TASK_MANAGER]   - taskId: ${taskId}`);

  const existing = activeTaskIds.get(sessionId);

  if (existing) {
    logger.log(`[TASK_MANAGER]   - Previous taskId: ${existing.currentTaskId}`);
    logger.log(`[TASK_MANAGER]   - 🔄 Updating taskId`);

    existing.currentTaskId = taskId;
    existing.currentMessageId = messageId;
    existing.updatedAt = Date.now();

    return true; // isUpdate
  } else {
    const binding: TaskIdBinding = {
      sessionId,
      currentTaskId: taskId,
      currentMessageId: messageId,
      updatedAt: Date.now(),
    };

    activeTaskIds.set(sessionId, binding);
    logger.log(`[TASK_MANAGER]   - ✅ TaskId registered (new)`);
    return false;
  }
}

/**
 * 移除session的活跃taskId（消息处理完成时调用）。
 */
export function decrementTaskIdRef(sessionId: string): void {
  logger.log(`[TASK_MANAGER] 🗑️  Removing taskId for ${sessionId}`);
  activeTaskIds.delete(sessionId);
}

/**
 * 获取session的当前活跃taskId
 */
export function getCurrentTaskId(sessionId: string): string | null {
  const binding = activeTaskIds.get(sessionId);
  return binding?.currentTaskId ?? null;
}

/**
 * 获取session的当前活跃messageId
 */
export function getCurrentMessageId(sessionId: string): string | null {
  const binding = activeTaskIds.get(sessionId);
  return binding?.currentMessageId ?? null;
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

/**
 * 强制清理（错误恢复用）
 */
export function forceCleanTaskId(sessionId: string): void {
  logger.log(`[TASK_MANAGER] ⚠️  Force clearing taskId for ${sessionId}`);
  activeTaskIds.delete(sessionId);
}

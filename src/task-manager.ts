// TaskId Manager - 管理session级别的活跃taskId
// 支持动态切换taskId，用于steer模式下的消息插队
import { logger } from "./utils/logger.js";

interface TaskIdBinding {
  sessionId: string;
  currentTaskId: string;
  currentMessageId: string;
  refCount: number;  // 引用计数
  updatedAt: number;
  locked: boolean;  // 防止被过早清理
}

/**
 * Session到活跃TaskId的映射
 * Key: sessionId (注意：这里用sessionId，不是sessionKey)
 * Value: TaskIdBinding
 * Uses globalThis to ensure a single Map across all module copies.
 */
const _g = globalThis as Record<string, unknown>;
if (!_g.__xyActiveTaskIds) {
  _g.__xyActiveTaskIds = new Map<string, TaskIdBinding>();
}
const activeTaskIds = _g.__xyActiveTaskIds as Map<string, TaskIdBinding>;

/**
 * 注册或更新session的活跃taskId
 * 返回是否是更新（用于判断是否是第二条消息）
 */
export function registerTaskId(
  sessionId: string,
  taskId: string,
  messageId: string,
  options?: { incrementRef?: boolean }
): { isUpdate: boolean; refCount: number } {
  logger.log(`[TASK_MANAGER] 📝 Registering/Updating taskId for session: ${sessionId}`);
  logger.log(`[TASK_MANAGER]   - New taskId: ${taskId}`);
  logger.log(`[TASK_MANAGER]   - New messageId: ${messageId}`);
  logger.log(`[TASK_MANAGER]   - incrementRef: ${options?.incrementRef ?? false}`);

  const existing = activeTaskIds.get(sessionId);

  if (existing) {
    logger.log(`[TASK_MANAGER]   - Previous taskId: ${existing.currentTaskId}`);
    logger.log(`[TASK_MANAGER]   - Previous refCount: ${existing.refCount}`);
    logger.log(`[TASK_MANAGER]   - 🔄 Switching taskId (steer mode detected)`);

    // 更新taskId，但保持引用计数
    existing.currentTaskId = taskId;
    existing.currentMessageId = messageId;
    existing.updatedAt = Date.now();

    if (options?.incrementRef) {
      existing.refCount++;
      logger.log(`[TASK_MANAGER]   - Incremented refCount: ${existing.refCount}`);
    }

    logger.log(`[TASK_MANAGER]   - ✅ TaskId updated, refCount=${existing.refCount}`);
    return { isUpdate: true, refCount: existing.refCount };
  } else {
    // 新注册
    const binding: TaskIdBinding = {
      sessionId,
      currentTaskId: taskId,
      currentMessageId: messageId,
      refCount: 1,
      updatedAt: Date.now(),
      locked: false,
    };

    activeTaskIds.set(sessionId, binding);
    logger.log(`[TASK_MANAGER]   - ✅ TaskId registered (new), refCount=1`);
    return { isUpdate: false, refCount: 1 };
  }
}

/**
 * 增加引用计数（消息开始处理时调用）
 */
export function incrementTaskIdRef(sessionId: string): void {
  const binding = activeTaskIds.get(sessionId);
  if (binding) {
    binding.refCount++;
    logger.log(`[TASK_MANAGER] ➕ Incremented refCount for ${sessionId}: ${binding.refCount}`);
  }
}

/**
 * 减少引用计数，当refCount=0时才真正清理
 */
export function decrementTaskIdRef(sessionId: string): void {
  const binding = activeTaskIds.get(sessionId);
  if (!binding) {
    logger.log(`[TASK_MANAGER] ⚠️  No binding found for ${sessionId}`);
    return;
  }

  binding.refCount--;
  logger.log(`[TASK_MANAGER] ➖ Decremented refCount for ${sessionId}: ${binding.refCount}`);

  if (binding.refCount <= 0 && !binding.locked) {
    logger.log(`[TASK_MANAGER] 🗑️  RefCount=0 and unlocked, clearing taskId`);
    activeTaskIds.delete(sessionId);
  } else {
    logger.log(`[TASK_MANAGER]   - Keeping binding (refCount=${binding.refCount}, locked=${binding.locked})`);
  }
}

/**
 * 锁定taskId，防止被清理（第一个消息使用）
 */
export function lockTaskId(sessionId: string): void {
  const binding = activeTaskIds.get(sessionId);
  if (binding) {
    binding.locked = true;
    logger.log(`[TASK_MANAGER] 🔒 Locked taskId for ${sessionId}`);
  }
}

/**
 * 解锁taskId（第一个消息完成时使用）
 */
export function unlockTaskId(sessionId: string): void {
  const binding = activeTaskIds.get(sessionId);
  if (binding) {
    binding.locked = false;
    logger.log(`[TASK_MANAGER] 🔓 Unlocked taskId for ${sessionId}`);

    // 解锁后，如果refCount=0，立即清理
    if (binding.refCount <= 0) {
      logger.log(`[TASK_MANAGER] 🗑️  Unlocked and refCount=0, clearing taskId`);
      activeTaskIds.delete(sessionId);
    }
  }
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
 * 获取完整的binding信息（用于调试）
 */
export function getTaskIdBinding(sessionId: string): TaskIdBinding | null {
  return activeTaskIds.get(sessionId) ?? null;
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

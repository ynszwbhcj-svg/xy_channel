// TaskId Manager - 管理session级别的活跃taskId
// 用于 monitor.ts 检测活跃任务（决定是否并发执行steer消息）
import { logger } from "./utils/logger.js";

interface TaskIdBinding {
  sessionId: string;
  currentTaskId: string;
  currentMessageId: string;
  updatedAt: number;
  /** 引用计数：每次 registerTaskId +1，每次 decrementTaskIdRef -1，归零时删除 */
  refCount: number;
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
    logger.log(`[TASK_MANAGER] Updating taskId: ${existing.currentTaskId} → ${taskId}, refCount: ${existing.refCount} → ${existing.refCount + 1}`);
    existing.currentTaskId = taskId;
    existing.currentMessageId = messageId;
    existing.updatedAt = Date.now();
    existing.refCount++;
    return true; // isUpdate
  } else {
    activeTaskIds.set(sessionId, {
      sessionId,
      currentTaskId: taskId,
      currentMessageId: messageId,
      updatedAt: Date.now(),
      refCount: 1,
    });
    logger.log(`[TASK_MANAGER] Registered new taskId: ${taskId}, refCount: 1`);
    return false;
  }
}

/**
 * 移除session的活跃taskId（消息处理完成时调用）。
 */
export function decrementTaskIdRef(sessionId: string): void {
  const binding = activeTaskIds.get(sessionId);
  if (!binding) {
    logger.log(`[TASK_MANAGER] decrementTaskIdRef: no binding for ${sessionId}`);
    return;
  }
  binding.refCount--;
  logger.log(`[TASK_MANAGER] decrementTaskIdRef: taskId=${binding.currentTaskId}, refCount: ${binding.refCount + 1} → ${binding.refCount}`);
  if (binding.refCount <= 0) {
    activeTaskIds.delete(sessionId);
    logger.log(`[TASK_MANAGER] Removed taskId binding (refCount reached 0)`);
  }
}

/**
 * 获取session的当前活跃taskId。
 * 仅供 reply-dispatcher 跨链读取 steer 更新后的 taskId。
 * 工具和 sendCommand 应使用 ALS SessionContext.taskId。
 */
export function getCurrentTaskId(sessionId: string): string | null {
  const binding = activeTaskIds.get(sessionId);
  return binding?.currentTaskId ?? null;
}

/**
 * 获取session的当前活跃messageId。
 * 仅供 reply-dispatcher 跨链读取 steer 更新后的 messageId。
 */
export function getCurrentMessageId(sessionId: string): string | null {
  const binding = activeTaskIds.get(sessionId);
  return binding?.currentMessageId ?? null;
}

/**
 * 更新 session 的活跃 taskId/messageId（不操作 refCount）。
 * 用于 InvokeJarvisGUIAgentResponse 等异步响应事件携带的 taskId 更新场景。
 */
export function updateTaskId(
  sessionId: string,
  taskId: string,
  messageId: string,
): void {
  const existing = activeTaskIds.get(sessionId);
  if (existing) {
    logger.log(`[TASK_MANAGER] updateTaskId: ${existing.currentTaskId} → ${taskId}`);
    existing.currentTaskId = taskId;
    existing.currentMessageId = messageId;
    existing.updatedAt = Date.now();
  } else {
    logger.log(`[TASK_MANAGER] updateTaskId: no existing binding for ${sessionId}, skipping`);
  }
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

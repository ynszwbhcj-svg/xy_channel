// TaskId Manager - 管理session级别的活跃taskId
// 用于 monitor.ts 检测活跃任务（决定是否并发执行steer消息）
import { logger } from "./utils/logger.js";

interface TaskIdBinding {
  sessionId: string;
  currentTaskId: string;
  currentMessageId: string;
  updatedAt: number;
  tasks?: TaskIdEntry[];
}

interface TaskIdEntry {
  taskId: string;
  messageId: string;
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

function normalizeTasks(binding: TaskIdBinding): TaskIdEntry[] {
  if (Array.isArray(binding.tasks) && binding.tasks.length > 0) {
    return binding.tasks;
  }
  return [{
    taskId: binding.currentTaskId,
    messageId: binding.currentMessageId,
    updatedAt: binding.updatedAt,
  }];
}

function syncCurrent(binding: TaskIdBinding, tasks: TaskIdEntry[]): void {
  binding.tasks = tasks;
  const current = tasks[tasks.length - 1];
  if (!current) {
    activeTaskIds.delete(binding.sessionId);
    return;
  }
  binding.currentTaskId = current.taskId;
  binding.currentMessageId = current.messageId;
  binding.updatedAt = current.updatedAt;
}

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
  const now = Date.now();

  if (existing) {
    logger.log(`[TASK_MANAGER] Updating taskId: ${existing.currentTaskId} → ${taskId}`);
    const tasks = normalizeTasks(existing).filter((entry) => entry.taskId !== taskId);
    tasks.push({ taskId, messageId, updatedAt: now });
    syncCurrent(existing, tasks);
    return true; // isUpdate
  } else {
    activeTaskIds.set(sessionId, {
      sessionId,
      currentTaskId: taskId,
      currentMessageId: messageId,
      updatedAt: now,
      tasks: [{ taskId, messageId, updatedAt: now }],
    });
    logger.log(`[TASK_MANAGER] Registered new taskId: ${taskId}`);
    return false;
  }
}

/**
 * 移除session的活跃taskId（消息处理完成时调用）。
 */
export function decrementTaskIdRef(sessionId: string, expectedTaskId?: string): void {
  const existing = activeTaskIds.get(sessionId);
  if (!existing) {
    logger.log(`[TASK_MANAGER] Removing taskId`);
    return;
  }

  if (expectedTaskId) {
    const tasks = normalizeTasks(existing);
    const nextTasks = tasks.filter((entry) => entry.taskId !== expectedTaskId);
    if (nextTasks.length === tasks.length) {
      logger.log(`[TASK_MANAGER] Preserving taskId ${existing.currentTaskId}; completed task ${expectedTaskId} is not active`);
      return;
    }
    syncCurrent(existing, nextTasks);
    if (nextTasks.length > 0) {
      logger.log(`[TASK_MANAGER] Removed taskId ${expectedTaskId}, restored current taskId ${existing.currentTaskId}`);
    } else {
      logger.log(`[TASK_MANAGER] Removing taskId`);
    }
    return;
  }
  logger.log(`[TASK_MANAGER] Removing taskId`);
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
  logger.log(`[TASK_MANAGER] Force clearing taskId`);
  activeTaskIds.delete(sessionId);
}

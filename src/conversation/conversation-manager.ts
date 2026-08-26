// 对话管理层 —— ConversationManager。
//
// 收拢 openclaw 与 xy server 之间的会话状态与生命周期管理：
//   - session 注册表（globalThis 单例，跨模块去重存活）
//   - task 身份链（吸收自原 task-manager.ts）
//   - sessionKey ↔ sessionId 索引（吸收自原 subagent-wait-state.ts 的 sessionKeyMap）
//   - subagent 等待态（吸收自原 subagent-wait-state.ts）
//   - XY config 缓存（吸收自原 __xyCachedXYConfig）
//
// 依赖方向约束：本模块只允许依赖 conversation-session / utils / types，
// 禁止 import dispatch 层（bot/reply-dispatcher/monitor/outbound），避免循环。

import { randomUUID } from "crypto";
import { logger } from "../utils/logger.js";
import { sendStatusUpdate, sendA2AResponse } from "../formatter.js";
import type { XYChannelConfig } from "../types.js";
import {
  ConversationSession,
  SubagentWaitState,
  SubagentWaitTransition,
  TaskEntry,
  createConversationSession,
} from "./conversation-session.js";

// ─── Global registry（globalThis 单例） ───────────────────────

const _g = globalThis as Record<string, unknown>;
if (!_g.__xyConversationSessions) {
  _g.__xyConversationSessions = new Map<string, ConversationSession>();
}
if (!_g.__xySessionKeyIndex) {
  // sessionKey → 首条消息的 { sessionId, taskId, messageId }。
  // 注意：taskId/messageId 刻意保留首条消息的值（steer 消息不覆盖），
  // 与原 registerSessionKeyMapping 语义一致。
  _g.__xySessionKeyIndex = new Map<string, { sessionId: string; taskId: string; messageId: string }>();
}
if (!_g.__xyConversationCachedConfig) {
  _g.__xyConversationCachedConfig = null;
}

const sessions = _g.__xyConversationSessions as Map<string, ConversationSession>;
const sessionKeyIndex = _g.__xySessionKeyIndex as Map<string, { sessionId: string; taskId: string; messageId: string }>;

// ─── Session registry ─────────────────────────────────────────

export function getOrCreateSession(sessionId: string): ConversationSession {
  let session = sessions.get(sessionId);
  if (!session) {
    session = createConversationSession(sessionId);
    sessions.set(sessionId, session);
  }
  session.lastActivityAt = Date.now();
  return session;
}

export function getSession(sessionId: string): ConversationSession | null {
  return sessions.get(sessionId) ?? null;
}

export function deleteSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  session?.outboundQueue.destroy();
  sessions.delete(sessionId);
}

export function listSessions(): ConversationSession[] {
  return Array.from(sessions.values());
}

/** 会话状态迁移（working / waiting-subagent / completing / 终态）。 */
export function setSessionState(sessionId: string, state: ConversationSession["state"]): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.state = state;
    session.lastActivityAt = Date.now();
  }
}

// ─── Task 身份链（吸收自原 task-manager.ts） ──────────────────

/**
 * 注册或更新 session 的活跃 taskId。
 * Returns true if this was an update (session already had an active task).
 */
export function registerTask(sessionId: string, taskId: string, messageId: string): boolean {
  const session = getOrCreateSession(sessionId);
  const isUpdate = session.tasks.length > 0;
  if (isUpdate) {
    logger.log(`[TASK_MANAGER] Updating taskId: ${session.tasks[session.tasks.length - 1].taskId} → ${taskId}`);
  } else {
    logger.log(`[TASK_MANAGER] Registered new taskId: ${taskId}`);
  }
  session.tasks = session.tasks.filter((entry) => entry.taskId !== taskId);
  session.tasks.push({ taskId, messageId, updatedAt: Date.now() });
  return isUpdate;
}

/**
 * 移除 session 的活跃 taskId（消息处理完成时调用）。
 * @param expectedTaskId 可选：精确移除指定的 taskId，而非清空整个任务链。
 */
export function completeTask(sessionId: string, expectedTaskId?: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (!expectedTaskId) {
    logger.log(`[TASK_MANAGER] Removing taskId`);
    session.tasks = [];
    return;
  }

  const nextTasks = session.tasks.filter((entry) => entry.taskId !== expectedTaskId);
  if (nextTasks.length === session.tasks.length) {
    const current = session.tasks[session.tasks.length - 1];
    logger.log(`[TASK_MANAGER] Preserving taskId ${current?.taskId}; completed task ${expectedTaskId} is not active`);
    return;
  }
  session.tasks = nextTasks;
  if (nextTasks.length > 0) {
    logger.log(`[TASK_MANAGER] Removed taskId ${expectedTaskId}, restored current taskId ${nextTasks[nextTasks.length - 1].taskId}`);
  } else {
    logger.log(`[TASK_MANAGER] Removing taskId (last task ${expectedTaskId})`);
  }
}

/** 获取 session 当前活跃 task（任务链末尾）。 */
export function getCurrentTask(sessionId: string): TaskEntry | null {
  const session = sessions.get(sessionId);
  if (!session || session.tasks.length === 0) return null;
  return session.tasks[session.tasks.length - 1];
}

/** 获取 session 当前活跃 taskId（reply-dispatcher 跨链读取 / 工具富化用）。 */
export function getCurrentTaskId(sessionId: string): string | null {
  return getCurrentTask(sessionId)?.taskId ?? null;
}

/** 获取 session 当前活跃 messageId。 */
export function getCurrentMessageId(sessionId: string): string | null {
  return getCurrentTask(sessionId)?.messageId ?? null;
}

export function hasActiveTask(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  return !!session && session.tasks.length > 0;
}

/** 所有活跃 task 绑定（gateway_stop 通知等场景）。 */
export function listActiveTaskBindings(): Array<{
  sessionId: string;
  currentTaskId: string;
  currentMessageId: string;
  updatedAt: number;
}> {
  const result: Array<{ sessionId: string; currentTaskId: string; currentMessageId: string; updatedAt: number }> = [];
  for (const session of sessions.values()) {
    const current = session.tasks[session.tasks.length - 1];
    if (current) {
      result.push({
        sessionId: session.sessionId,
        currentTaskId: current.taskId,
        currentMessageId: current.messageId,
        updatedAt: current.updatedAt,
      });
    }
  }
  return result;
}

// ─── 在途 turn 跟踪（subagent 终态帧时机门控） ───────────────

/**
 * dispatch 时登记在途 turn（bot.ts 创建 dispatcher 后调用）。
 * 注意：steer 直接注入成功的路径不 dispatch，不得登记。
 */
export function markTurnInflight(sessionId: string, taskId: string): void {
  const session = getOrCreateSession(sessionId);
  if (!session.inflightTurns) {
    session.inflightTurns = new Set();
  }
  session.inflightTurns.add(taskId);
}

/** turn 不再产生流式帧时清除在途标记（onIdle 入口 / onSettled 兜底）。 */
export function clearTurnInflight(sessionId: string, taskId: string): void {
  const session = sessions.get(sessionId);
  session?.inflightTurns?.delete(taskId);
}

/** session 内是否仍有 turn 在流式输出（未 idle）。 */
function hasInflightTurn(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  return (session?.inflightTurns?.size ?? 0) > 0;
}

// ─── SessionKey ↔ SessionId 索引 ──────────────────────────────

/**
 * 绑定 openclaw sessionKey 到首条消息的 A2A 身份。
 * 仅在首条消息时调用（steer 消息不覆盖，保持 subagent 等待态跟踪稳定）。
 */
export function bindSessionKey(sessionKey: string, sessionId: string, taskId: string, messageId: string): void {
  if (!sessionKey || !sessionId) return;
  sessionKeyIndex.set(sessionKey, { sessionId, taskId, messageId });
  const session = getOrCreateSession(sessionId);
  session.sessionKey = sessionKey;
}

export function resolveBySessionKey(sessionKey: string): { sessionId: string; taskId: string; messageId: string } | null {
  return sessionKeyIndex.get(sessionKey) ?? null;
}

export function unbindSessionKey(sessionKey: string): void {
  sessionKeyIndex.delete(sessionKey);
}

// ─── XY config 缓存 ───────────────────────────────────────────

/**
 * 全局缓存 resolved XY config，供 hook 上下文（无 raw ClawdbotConfig）使用。
 */
export function cacheXYConfig(config: unknown): void {
  _g.__xyConversationCachedConfig = config;
}

export function getCachedXYConfig(): unknown {
  return _g.__xyConversationCachedConfig;
}

// ─── 30s 状态心跳（manager 拥有，独立于 dispatcher 生命周期） ──

const STATUS_HEARTBEAT_INTERVAL_MS = 30 * 1000;
const DEFAULT_STATUS_TEXT = "任务正在处理中，请稍候~";

/**
 * 启动（或重启）session 的 30s 状态心跳。
 * 心跳由 manager 拥有：dispatcher 销毁不影响心跳；
 * tick 时读取任务链末尾的当前 taskId/messageId。
 */
export function startStatusHeartbeat(sessionId: string, text: string = DEFAULT_STATUS_TEXT): void {
  const session = getOrCreateSession(sessionId);
  if (session.statusTimer) {
    clearInterval(session.statusTimer);
  }
  logger.withContext(sessionId, "").log(`[STATUS-HEARTBEAT] Starting manager-owned heartbeat, text="${text}"`);
  session.statusTimer = setInterval(() => {
    const current = getCurrentTask(sessionId);
    const config = getCachedXYConfig() as XYChannelConfig | null;
    if (!current || !config) {
      return;
    }
    void sendStatusUpdate({
      config,
      sessionId,
      taskId: current.taskId,
      messageId: current.messageId,
      text,
      state: "working",
    }).catch((err) => {
      logger.withContext(sessionId, current.taskId).error(`Failed to send status update:`, err);
    });
  }, STATUS_HEARTBEAT_INTERVAL_MS);
}

export function stopStatusHeartbeat(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session?.statusTimer) {
    logger.withContext(sessionId, "").log(`[STATUS-HEARTBEAT] Stopping manager-owned heartbeat`);
    clearInterval(session.statusTimer);
    session.statusTimer = undefined;
  }
}

// ─── Subagent 等待态（吸收自原 subagent-wait-state.ts） ───────

const WAIT_TTL_MS = 30 * 60 * 1000; // 30 minutes

function isExpired(state: SubagentWaitState): boolean {
  return Date.now() - state.startedAt > WAIT_TTL_MS;
}

function isComplete(state: SubagentWaitState): boolean {
  return state.deliveredCompletions >= Math.max(1, state.expectedCompletions);
}

function claimFinalizationIfReady(state: SubagentWaitState): boolean {
  if (state.finalizationClaimed) return false;
  if (!state.parentSettled || !isComplete(state)) return false;
  state.finalizationClaimed = true;
  return true;
}

function getStatesArray(sessionId: string): SubagentWaitState[] {
  const session = sessions.get(sessionId);
  if (!session) return [];
  const active = session.subagentWaits.filter((s) => {
    if (!isExpired(s)) return true;
    stopStatusHeartbeat(sessionId);
    logger.withContext(sessionId, s.taskId).log(
      `[SUBAGENT-WAIT] Expired wait state cleared, expected=${s.expectedCompletions}, delivered=${s.deliveredCompletions}`,
    );
    return false;
  });
  session.subagentWaits = active;
  return active;
}

/**
 * subagent_spawned hook 调用。递增 expected completion 计数。
 * 若等待态尚不存在则创建（sessions_spawn 可能先于 sessions_yield）。
 */
export function markSubagentSpawned(sessionKey: string): number {
  const mapped = resolveBySessionKey(sessionKey);
  if (!mapped) {
    logger.log(`[SUBAGENT-WAIT] No session mapping for sessionKey=${sessionKey.slice(0, 30)}`);
    return 0;
  }

  const { sessionId, taskId, messageId } = mapped;
  const session = getOrCreateSession(sessionId);
  const states = getStatesArray(sessionId);
  let state = states.find((s) => s.taskId === taskId);

  if (!state) {
    state = {
      sessionId,
      sessionKey,
      taskId,
      messageId,
      artifactId: randomUUID(),
      startedAt: Date.now(),
      expectedCompletions: 0,
      deliveredCompletions: 0,
      completionTexts: [],
      parentSettled: false,
      finalizationClaimed: false,
      finalDeliveryStarted: false,
    };
    states.push(state);
  }

  state.expectedCompletions = Math.max(1, state.expectedCompletions + 1);
  session.subagentWaits = states;

  logger.withContext(sessionId, taskId).log(
    `[SUBAGENT-WAIT] Subagent spawned, expected=${state.expectedCompletions}`,
  );
  return state.expectedCompletions;
}

/**
 * subagent_ended hook 调用。标记一个 subagent run 结束并计为一次交付。
 * 这是主要的完成跟踪机制（subagent 完成可能不经 xyOutbound.sendText）。
 */
export function markSubagentEnded(sessionKey: string): SubagentWaitTransition | null {
  const mapped = resolveBySessionKey(sessionKey);
  if (!mapped) return null;

  const { sessionId, taskId } = mapped;
  const session = getOrCreateSession(sessionId);
  const states = getStatesArray(sessionId);
  const state = states.find((s) => s.taskId === taskId);
  if (!state) {
    logger.withContext(sessionId, taskId).log(
      `[SUBAGENT-WAIT] Subagent ended but no wait state found`,
    );
    return null;
  }

  state.deliveredCompletions += 1;
  const complete = isComplete(state);
  const shouldFinalize = claimFinalizationIfReady(state);

  logger.withContext(sessionId, taskId).log(
    `[SUBAGENT-WAIT] Subagent ended, delivered=${state.deliveredCompletions}/${state.expectedCompletions}, complete=${complete}, shouldFinalize=${shouldFinalize}`,
  );
  return { state, isComplete: complete, shouldFinalize };
}

/**
 * bot.ts onSettled 调用。标记父 dispatcher 已 settle。
 */
export function markParentSettled(sessionId: string, taskId: string): SubagentWaitTransition | null {
  const session = getOrCreateSession(sessionId);
  const states = getStatesArray(sessionId);
  const state = states.find((s) => s.taskId === taskId);
  if (!state) {
    logger.withContext(sessionId, taskId).log(
      `[SUBAGENT-WAIT] No wait state matched for parent settled`,
    );
    return null;
  }

  state.parentSettled = true;
  const complete = isComplete(state);
  const shouldFinalize = claimFinalizationIfReady(state);

  logger.withContext(sessionId, taskId).log(
    `[SUBAGENT-WAIT] Parent settled, completions=${state.deliveredCompletions}/${state.expectedCompletions}, shouldFinalize=${shouldFinalize}`,
  );
  return { state, isComplete: complete, shouldFinalize };
}

/**
 * 存储从 xyOutbound.sendText 捕获的完成文本。不递增交付计数。
 */
export function addCompletionText(sessionId: string, taskId: string, text: string): void {
  const states = getStatesArray(sessionId);
  const state = states.find((s) => s.taskId === taskId);
  if (!state || !text.trim()) return;
  state.completionTexts.push(text.trim());
}

export function getWaitState(sessionId: string, taskId?: string): SubagentWaitState | null {
  const states = getStatesArray(sessionId);
  if (states.length === 0) return null;
  if (taskId) {
    return states.find((s) => s.taskId === taskId) ?? null;
  }
  // FIFO: 未指定 taskId 时返回最早的等待态
  return states[0] ?? null;
}

export function hasWaitState(sessionId: string, taskId?: string): boolean {
  return getWaitState(sessionId, taskId) !== null;
}

export function clearWaitState(sessionId: string, reason: string, taskId?: string): SubagentWaitState | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const states = getStatesArray(sessionId);
  if (states.length === 0) return null;

  const index = taskId
    ? states.findIndex((s) => s.taskId === taskId)
    : 0;
  if (index < 0) {
    logger.withContext(sessionId, taskId ?? "").log(
      `[SUBAGENT-WAIT] No wait state matched for clear, reason=${reason}`,
    );
    return null;
  }

  const [state] = states.splice(index, 1);
  stopStatusHeartbeat(sessionId);
  session.subagentWaits = states;

  logger.withContext(sessionId, state.taskId).log(
    `[SUBAGENT-WAIT] Cleared wait state, reason=${reason}, remaining=${states.length}`,
  );
  return state;
}

// ─── Subagent 最终交付（收拢自原 outbound.deliverSubagentFinalResult） ──

/**
 * 当所有 subagent 完成且父 turn 已 settle 时，由 manager 发送终态帧并真正
 * 结束当前 A2A session：
 *   1. completed 状态帧（"任务处理已完成~"）→ final:true 全文本帧（合并
 *      completionTexts）——与 reply-dispatcher 正常终态同序，xy_tester
 *      与客户端依赖该顺序
 *   2. 清理等待态、停止心跳、移除任务链
 *   3. 会话状态迁移到 completed
 */
export async function deliverSubagentFinalResult(params: {
  state: SubagentWaitState;
  reason?: string;
  text?: string;
}): Promise<void> {
  const { state, reason } = params;
  const log = logger.withContext(state.sessionId, state.taskId);

  // 🔑 幂等 guard：终态交付只执行一次。onIdle defer 分支 / onSettled 安全网 /
  // subagent_ended hook 可能相继触发交付，重复调用为 no-op。
  // （检查与下方 finalDeliveryStarted 置位之间无 await，不会并发穿透。）
  if (state.finalDeliveryStarted) {
    log.log(`[SUBAGENT-FINAL] Final delivery already started, skipping duplicate trigger, reason=${reason}`);
    return;
  }

  // 🔑 时机门控：session 内仍有 turn 在流式输出（steer 重分发的新 turn 未
  // idle）时推迟交付 —— 此时以最新 taskId 发 final:true 会提前截断在途
  // 回复，且新 turn 之后还会再发一次 final（双重终态帧）。推迟期间
  // waitState 完整保留（parentSettled、完成计数等就绪态不丢失），由在途
  // turn 的 onIdle defer 分支或 onSettled 安全网就地交付，身份仍取任务链末尾。
  if (hasInflightTurn(state.sessionId)) {
    log.log(`[SUBAGENT-FINAL] Deferring final delivery — turn still in flight, reason=${reason}`);
    return;
  }

  const config = getCachedXYConfig() as XYChannelConfig | null;
  if (!config) {
    log.error(`[SUBAGENT-FINAL] No cached XY config, cannot deliver final result`);
    return;
  }

  // 关闭捕获窗口：此后到达的 sendText 不再并入 final 文本。
  // 等待态在发送后立即清除，迟到的 announce 文本回退 push 通道兜底（不丢消息）。
  state.finalDeliveryStarted = true;

  const finalText = state.completionTexts.length > 0
    ? state.completionTexts.join("\n\n")
    : (params.text || undefined) ?? "子任务已完成";

  setSessionState(state.sessionId, "completing");

  // final 帧走会话出站队列：排在任何在途 partial 帧之后，保证客户端
  // 先收齐流式正文再收到 final（与 reply-dispatcher 的终态帧同一收口点）。
  // 终态帧延迟同 reply-dispatcher 的 terminalFrameDelayMs 治理：让已发出的
  // 长正文先穿过下游服务端慢速管道，保证终态帧最后到达。
  // 解析下发帧所用的 A2A 身份：跟随任务链末尾的最新 taskId/messageId。
  // steer 重分发场景下 state.taskId 为旧身份，取链尾可保证终态帧与
  // 心跳/保活帧的 taskId 一致，客户端不会看到 taskId 跳跃。
  const effectiveTaskId = getCurrentTaskId(state.sessionId) ?? state.taskId;
  const effectiveMessageId = getCurrentMessageId(state.sessionId) ?? state.messageId;

  const terminalFrameDelayMs = config.terminalFrameDelayMs ?? 0;
  const session = sessions.get(state.sessionId);
  const sendCompletedStatus = () =>
    sendStatusUpdate({
      config,
      sessionId: state.sessionId,
      taskId: effectiveTaskId,
      messageId: effectiveMessageId,
      text: "任务处理已完成~",
      state: "completed",
    });
  const sendFinal = () =>
    sendA2AResponse({
      config,
      sessionId: state.sessionId,
      taskId: effectiveTaskId,
      messageId: effectiveMessageId,
      text: finalText,
      append: false,
      final: true,
    });
  if (session) {
    session.outboundQueue.enqueue({
      taskId: effectiveTaskId,
      label: "subagent-terminal-status",
      delayMs: terminalFrameDelayMs,
      send: sendCompletedStatus,
    });
    session.outboundQueue.enqueue({
      taskId: effectiveTaskId,
      label: "subagent-final",
      delayMs: terminalFrameDelayMs,
      send: sendFinal,
    });
    await session.outboundQueue.whenIdle();
  } else {
    await sendCompletedStatus();
    await sendFinal();
  }

  clearWaitState(state.sessionId, reason ?? "all-subagent-results-delivered", state.taskId);
  // 清理整个任务链（无 expectedTaskId），避免 steer 引入的额外 taskId 残留。
  completeTask(state.sessionId);
  setSessionState(state.sessionId, "completed");
  log.log(`[SUBAGENT-FINAL] Subagent final delivered, reason=${reason}, effectiveTaskId=${effectiveTaskId}`);
}

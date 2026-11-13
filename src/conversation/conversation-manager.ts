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
import { releaseStreamingTextId, releaseLastSentStreamingTextId, rotateStreamingTextId, peekStreamingTextId, getOrCreateStreamingTextId } from "../utils/streaming-text-id.js";
import { releaseStatusCardSeq, getCurrentStatusCardSeq } from "../utils/status-card-seq.js";
import { markLastChunkBlock, getAccumulatedThinkIndex, releaseThinkIndex } from "../utils/think-index.js";
import { releaseAppVersion, isLegacyAppVersion } from "../utils/app-version.js";
import { clearBodyTextState, isBodyTextSent } from "../utils/body-text-state.js";
import {
  isReasoningSegmentOpen,
  closeReasoningSegment,
  cutReasoningSegment,
  peekReasoningSegmentText,
  peekReasoningSegmentSeq,
  releaseReasoningSegment,
} from "../utils/reasoning-segment.js";
import { sendStatusUpdate, sendA2AResponse, sendDisplayTaskCardData, sendExecuteStatusCard, sendReasoningTextUpdate, sendReference } from "../formatter.js";
import { drainPendingReferences, releasePendingReferences } from "../utils/pending-references.js";
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
  // 会话销毁：释放其任务链上所有 turn 的 streamingTextId、状态卡序号、
  // thinkIndex 标记、App 版本标记、正文首帧标记、思考分段状态与待下发引用
  for (const entry of session?.tasks ?? []) {
    releaseStreamingTextId(entry.taskId);
    releaseLastSentStreamingTextId(entry.taskId);
    releaseStatusCardSeq(entry.taskId);
    releaseThinkIndex(entry.taskId);
    releaseAppVersion(entry.taskId);
    clearBodyTextState(entry.taskId);
    releaseReasoningSegment(entry.taskId);
    releasePendingReferences(entry.taskId);
  }
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
  // 新 turn 开始：会话状态复位为 working —— 上一 turn 终态后状态停留在
  // completing/completed/failed，而心跳 tick 的状态门（仅 working /
  // waiting-subagent 发保活帧）依赖这里复位，否则后续 turn 心跳永久哑掉。
  session.state = "working";
  return isUpdate;
}

/**
 * 移除 session 的活跃 taskId（消息处理完成时调用）。
 * 同时释放该 task 对应 turn 的 streamingTextId（本轮文本流已结束）。
 * @param expectedTaskId 可选：精确移除指定的 taskId，而非清空整个任务链。
 */
export function completeTask(sessionId: string, expectedTaskId?: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (!expectedTaskId) {
    logger.log(`[TASK_MANAGER] Removing taskId`);
    for (const entry of session.tasks) {
      releaseStreamingTextId(entry.taskId);
      releaseLastSentStreamingTextId(entry.taskId);
      releaseReasoningSegment(entry.taskId);
      releasePendingReferences(entry.taskId);
    }
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
  releaseStreamingTextId(expectedTaskId);
  releaseLastSentStreamingTextId(expectedTaskId);
  releaseReasoningSegment(expectedTaskId);
  releasePendingReferences(expectedTaskId);
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

/**
 * 文本分段边界（工具调用/返回时调用，见 step-info-tool），按序完成四个副作用：
 *   1. 正文旧段收尾：装配器有内容时，以当前（旧）streamingTextId 经出站队列
 *      补发一帧旧段完整全文本（lastChunk=true，标识旧流文本块已结束），
 *      并等队列排空 —— 保证旧 id 段的尾部完整送达（在途 lazy partial 帧
 *      也在此期间以旧 id 发出）；
 *   2. 思考旧段收尾：当前 id 下有未闭合思考流块时，先补一帧 status-update
 *      （"已完成深度思考"，pin 思考段 id），再以旧 id 补发该段完整文本
 *      （lastChunk=true）并等队列排空 —— 保证每个携带过思考帧的 id 都有
 *      「状态帧 → 收尾帧」的闭合序列，端侧不会拿到没有 lastChunk=true 的
 *      中间 id 段；
 *   3. 轮换该 turn 的 streamingTextId，并切分思考段基线 —— 边界之后的
 *      思考帧使用新 id，且只携带剥离基线后的增量段文本（端侧按 id 聚合
 *      渲染，SDK 跨边界续流的全量快照含边界前文本，必须剥离）；
 *   4. 切分 session 的流式装配器 —— 后续 append:false 全量帧只携带边界
 *      之后新段的文本，不再叠加旧 id 段内容。
 * 返回新 streamingTextId。
 *
 * 每个独立的思考文本段都是独立的 streamingTextId：边界无条件拆分（无
 * 「正文出现前不拆分」门控）—— 思考段1……工具1、2、3……思考段2……正文1
 * 的路径中，思考段1 在首个工具边界以 id A 收尾并轮换到 id B，思考段2 在
 * 下一个边界以 id B 收尾；思考→正文的类型切换另由
 * rotateStreamingTextForBodyStart 收口（思考与正文不共用 id）。
 */
export async function rotateStreamingTextSegment(params: {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
}): Promise<string> {
  const { config, sessionId, taskId, messageId } = params;
  const session = sessions.get(sessionId);
  const assembler = session?.assembler;

  if (session && assembler?.hasContent()) {
    const oldSegmentText = assembler.getFullText();
    // 攒入旧文本块的 taskUniqIndexId：统一在终态汇总卡（text=任务处理已完成）
    // 携带，中间状态卡不携带。同步标记（而非等收尾帧 drain），保证不受
    // 出站队列时序影响。
    markLastChunkBlock(taskId, getCurrentStatusCardSeq(taskId));
    // 分段收尾帧：lastChunk=true 标识旧流文本块已结束（可开始下一块）。
    // 它是协议关键帧，不设 coalesceKey —— 若被后方同 key 全量帧合并丢弃，
    // 端侧将永远收不到旧块的结束标记。
    session.outboundQueue.enqueue({
      taskId,
      label: "segment-flush",
      send: () =>
        sendA2AResponse({
          config,
          sessionId,
          taskId,
          messageId,
          text: oldSegmentText,
          append: false,
          final: false,
          lastChunk: true,
        }),
    });
    await session.outboundQueue.whenIdle();
  }

  // 思考段收尾帧：lastChunk=true 标识当前 id 的思考流块已结束。与正文收尾
  // 同理不设 coalesceKey（协议关键帧，不可被合并丢弃）；isReasoningFinished
  // 显式 pin false —— 思考未结束、仅是分段边界（端侧按 lastChunk 闭合段，
  // 该字段无实际作用）。闭环依赖 whenIdle：收尾帧与在途思考帧的 drain 先
  // 于轮换，drain 时 lazy 读 id 的帧也仍以旧 id 发出。
  if (session && isReasoningSegmentOpen(taskId)) {
    // 攒入思考块的 taskUniqIndexId（与 onReasoningEnd 同理，终态汇总卡统一
    // 携带），同步标记不受出站队列时序影响。
    // 取思考块开块时锁存的序号：块期间下发的状态卡 command 推高的全局
    // 计数不属于本块（见 utils/reasoning-segment）。
    markLastChunkBlock(taskId, peekReasoningSegmentSeq(taskId));
    // 同步闭合分段（不等收尾帧 drain），onReasoningEnd 据此不再补标记帧
    closeReasoningSegment(taskId);
    // 段文本与 streamingTextId 均在入队时捕获/pin —— drain 期间新快照或
    // 轮换不影响本帧归属
    const segmentText = peekReasoningSegmentText(taskId);
    const streamingTextId = peekStreamingTextId(taskId);
    // 思考段结束状态帧：lastChunk 收尾帧之前补发，streamingTextId pin 思考段
    // id —— 端侧先落定「已完成深度思考」状态文案，再由 lastChunk=true 闭合段
    session.outboundQueue.enqueue({
      taskId,
      label: "reasoning-segment-end-status",
      send: () =>
        sendStatusUpdate({
          config,
          sessionId,
          taskId,
          messageId,
          text: "已完成深度思考",
          state: "working",
          streamingTextId,
        }),
    });
    session.outboundQueue.enqueue({
      taskId,
      label: "reasoning-segment-flush",
      send: () =>
        sendReasoningTextUpdate({
          config,
          sessionId,
          taskId,
          messageId,
          text: segmentText,
          append: false,
          isReasoningFinished: false,
          lastChunk: true,
          streamingTextId,
        }),
    });
    await session.outboundQueue.whenIdle();
  }

  // 思考段基线切分：无论本次是否发出思考收尾帧，id 即将轮换 —— 新 id 的
  // 思考帧不得再携带边界前文本（后续快照剥离基线后只保留增量段）。
  cutReasoningSegment(taskId);

  const newId = rotateStreamingTextId(taskId);
  assembler?.cutSegment();
  // 新文本段 = 新一轮模型回复：复位"正文首帧已发出"标记，工具 command
  // 重新获得先于正文下发的窗口（见 utils/body-text-state.ts）。
  clearBodyTextState(taskId);
  return newId;
}

/**
 * 思考→正文类型切换（高版本链路）：正文段首帧产生前调用（reply-dispatcher
 * 的 onPartialReply 流式路径 / deliver 非流式回退路径）。思考与正文不共用
 * streamingTextId —— 当前 id 段携带过思考内容时，正文首帧起轮换为新 id：
 *   1. 先等出站队列排空 —— 在途思考帧（id 入队时已 pin）与 lazy 读 id 的
 *      status-update 旁路帧均以旧 id 落定；
 *   2. 思考流块仍未闭合（SDK 未发 thinking_end 的防御路径）时，先补一帧
 *      status-update（"已完成深度思考"，pin 思考段 id），再以旧 id 补发
 *      该段完整文本（lastChunk=true）并再次等排空；
 *   3. 轮换 streamingTextId —— 正文帧自首帧起使用新 id。
 * 不轮换的情形（返回在役 id）：当前段无思考内容（纯正文段，id 已是新起点）、
 * 正文内容已出现（调用点应在新段首帧之前；重复调用幂等）、低版本链路
 * （无分段能力，整轮 turn 单 id）。
 * 与 rotateStreamingTextSegment 的分工：工具边界无条件拆分文本段（每个
 * 独立思考文本段都是独立的 streamingTextId）；思考→正文的类型切换点在
 * 正文首帧产生处，由本函数收口。
 */
export async function rotateStreamingTextForBodyStart(params: {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
}): Promise<string> {
  const { config, sessionId, taskId, messageId } = params;
  const session = sessions.get(sessionId);
  const assembler = session?.assembler;

  if (
    isLegacyAppVersion(taskId) ||
    assembler?.hasContent() ||
    isBodyTextSent(taskId) ||
    (!isReasoningSegmentOpen(taskId) && peekReasoningSegmentText(taskId).length === 0)
  ) {
    return getOrCreateStreamingTextId(taskId);
  }

  // 在途帧以旧 id 落定（drain 期间 lazy 读 id 的旁路帧也仍以旧 id 发出）
  if (session) await session.outboundQueue.whenIdle();

  // 思考流块未闭合（防御 SDK 未发 thinking_end）：收尾帧之前先补一帧
  // status-update（"已完成深度思考"，pin 思考段 id），再以旧 id 补收尾帧。
  // 与分段边界的思考收尾同理不设 coalesceKey（协议关键帧）；isReasoningFinished
  // 显式 pin false —— 此处是思考→正文的类型切换，非 thinking_end 语义。
  if (session && isReasoningSegmentOpen(taskId)) {
    // 攒入思考块的 taskUniqIndexId（终态汇总卡统一携带），同步标记不受出站
    // 队列时序影响。
    // 取思考块开块时锁存的序号（见 utils/reasoning-segment）。
    markLastChunkBlock(taskId, peekReasoningSegmentSeq(taskId));
    // 同步闭合分段（不等收尾帧 drain），onReasoningEnd 据此不再补标记帧
    closeReasoningSegment(taskId);
    // 段文本与 streamingTextId 均在入队时捕获/pin —— drain 期间新快照或
    // 轮换不影响本帧归属
    const segmentText = peekReasoningSegmentText(taskId);
    const streamingTextId = peekStreamingTextId(taskId);
    session.outboundQueue.enqueue({
      taskId,
      label: "reasoning-body-switch-status",
      send: () =>
        sendStatusUpdate({
          config,
          sessionId,
          taskId,
          messageId,
          text: "已完成深度思考",
          state: "working",
          streamingTextId,
        }),
    });
    session.outboundQueue.enqueue({
      taskId,
      label: "reasoning-body-switch-flush",
      send: () =>
        sendReasoningTextUpdate({
          config,
          sessionId,
          taskId,
          messageId,
          text: segmentText,
          append: false,
          isReasoningFinished: false,
          lastChunk: true,
          streamingTextId,
        }),
    });
    await session.outboundQueue.whenIdle();
  }

  const newId = rotateStreamingTextId(taskId);
  logger.withContext(sessionId, taskId).log(
    `[SEGMENT] reasoning→body switch, rotated streamingTextId=${newId}`,
  );
  return newId;
}

/**
 * 当前分段正文内容是否已产生（正文首帧已发出，或已装配/在队等待发出）。
 * 工具 command 门控（tool-status-hook / step-info-tool 的卡片抑制）使用：
 * 协议要求 command 必须先于正文下发 —— 正文内容一产生，本段后续卡片即
 * 抑制。判定覆盖"在队未发出"（装配器有内容）：正文帧走会话出站队列
 * drain、卡片直发 WS，仅查已发出标记（isBodyTextSent，drain 时置位）
 * 存在竞态窗口 —— 卡片可能越过在队正文帧落在其后（端工具多在最终
 * 正文之后调用，命中最多）。边界轮换后装配器 cutSegment + 标记复位，
 * 新段窗口照常重新打开。
 */
export function isBodyTextProduced(sessionId: string, taskId: string): boolean {
  if (isBodyTextSent(taskId)) return true;
  const session = sessions.get(sessionId);
  return session?.assembler?.hasContent() ?? false;
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
  session.latestDispatchTaskId = taskId;
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

// ─── Turn 生命周期（取消 / 被新 dispatch 接替） ─────────────────

/** 最近创建 dispatcher 的 taskId；直接 steer 不创建 dispatcher，不会改写它。 */
export function getCurrentDispatchTaskId(sessionId: string): string | null {
  return sessions.get(sessionId)?.latestDispatchTaskId ?? null;
}

/** 旧 dispatcher 已被新 dispatcher 接替后，不得再发送正文或终态帧。 */
export function isTurnSuperseded(sessionId: string, taskId: string): boolean {
  const latestTaskId = sessions.get(sessionId)?.latestDispatchTaskId;
  return latestTaskId !== undefined && latestTaskId !== taskId;
}

/** 记录取消仅用于阻止该 turn 的后续输出，不向下一条消息注入任何提示。 */
export function markTurnCanceled(sessionId: string, taskId: string): void {
  const session = getOrCreateSession(sessionId);
  session.canceledTurnIds.add(taskId);
  session.lastActivityAt = Date.now();
  logger.withContext(sessionId, taskId).log(`[TURN-CANCELED] Marked turn as canceled`);
}

export function isTurnCanceled(sessionId: string, taskId: string): boolean {
  return sessions.get(sessionId)?.canceledTurnIds.has(taskId) ?? false;
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

// ─── 30s 保活卡（manager 拥有，独立于 dispatcher 生命周期） ──

const STATUS_KEEPALIVE_INTERVAL_MS = 30 * 1000;

/**
 * 启动（或重启）session 的 30s 保活卡心跳。
 * 心跳由 manager 拥有：dispatcher 销毁不影响心跳；
 * tick 时读取任务链末尾的当前 taskId/messageId。
 * 每 30s 下发一张单独的 DisplayTaskCardData（不配对状态卡）：
 * stepName="任务正在处理中，请稍候"，index/taskUniqIndexId 取当前状态卡序号，
 * isFinal=false，其余字段沿用现有 DisplayTaskCardData 结构。
 */
export function startStatusHeartbeat(sessionId: string): void {
  const session = getOrCreateSession(sessionId);
  if (session.statusTimer) {
    clearInterval(session.statusTimer);
  }
  logger.withContext(sessionId, "").log(`[STATUS-HEARTBEAT] Starting manager-owned keepalive card heartbeat`);
  session.statusTimer = setInterval(() => {
    // 终态/收尾中不再发保活卡
    if (session.state !== "working" && session.state !== "waiting-subagent") {
      return;
    }
    const current = getCurrentTask(sessionId);
    const config = getCachedXYConfig() as XYChannelConfig | null;
    if (!current || !config) {
      return;
    }
    void sendDisplayTaskCardData({
      config,
      sessionId,
      taskId: current.taskId,
      messageId: current.messageId,
      index: getCurrentStatusCardSeq(current.taskId),
      stepName: "任务正在处理中，请稍候",
      isFinal: false,
    }).catch((err) => {
      logger.withContext(sessionId, current.taskId).error(`Failed to send keepalive card:`, err);
    });
  }, STATUS_KEEPALIVE_INTERVAL_MS);
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
 *   1. 正文文本完成帧（lastChunk=true 全文本帧，合并 completionTexts）——
 *      与 reply-dispatcher 正常终态同序（终态不下发 status-update
 *      "已完成深度思考"：该文案是思考期状态，发正文时不下发）
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
  // 正文文本完成帧（lastChunk=true, final=false）：权威全文本在此下发，
  // final=true 留给最后的空载终帧 —— 与 reply-dispatcher 终态序列一致
  // （正文 lastChunk → 汇总卡 → final）。终态不下发 status-update
  // （"已完成深度思考" state=completed）：该文案是思考期状态，发正文时
  // 不下发。终态帧延迟挂在本帧上（原 terminal-status 帧的 delayMs 语义）。
  const sendTextComplete = () =>
    sendA2AResponse({
      config,
      sessionId: state.sessionId,
      taskId: effectiveTaskId,
      messageId: effectiveMessageId,
      text: finalText,
      append: false,
      final: false,
      lastChunk: true,
    });
  // 引用来源帧：工具攒批的引用在最后一个正文帧（正文完成帧）之后下发，
  // 排在汇总卡之前；streamingTextId 由 sendReference 取 last-sent（即正文
  // 完成帧的 id）。与 reply-dispatcher 正常终态序列的落点一致。
  const pendingReferences = drainPendingReferences(effectiveTaskId);
  const sendPendingReferences = () =>
    sendReference({
      config,
      sessionId: state.sessionId,
      taskId: effectiveTaskId,
      messageId: effectiveMessageId,
      references: pendingReferences,
    });
  // 汇总状态卡：thinkIndex 攒批，text=任务处理已完成；排在 final 帧之前。
  // 携带规则（与 reply-dispatcher 终态路径一致）：除最后一轮正文段外，其余
  // 所有文本块都进 thinkIndex（全部思考块无一例外）—— 最后一轮正文 id =
  // 当前卡序号（同 seq 即同一块，一并过滤）。
  const sendSummaryCard = () =>
    sendExecuteStatusCard({
      config,
      sessionId: state.sessionId,
      taskId: effectiveTaskId,
      messageId: effectiveMessageId,
      text: "任务处理已完成",
      thinkIndex: getAccumulatedThinkIndex(effectiveTaskId)
        .filter((id) => id !== String(getCurrentStatusCardSeq(effectiveTaskId))),
    });
  // DisplayTaskCardData final 帧收尾对话轮（起始卡在 bot.ts 下发）；
  // 排在汇总卡之后（index 惰性读取，落在汇总卡序号上），final 帧之前。
  const sendTaskCardFinal = () =>
    sendDisplayTaskCardData({
      config,
      sessionId: state.sessionId,
      taskId: effectiveTaskId,
      messageId: effectiveMessageId,
      index: getCurrentStatusCardSeq(effectiveTaskId),
      stepName: "任务处理已完成",
      isFinal: true,
    });
  // 空载终帧（append:true, final:true）仅标记流结束
  const sendFinal = () =>
    sendA2AResponse({
      config,
      sessionId: state.sessionId,
      taskId: effectiveTaskId,
      messageId: effectiveMessageId,
      text: "",
      append: true,
      final: true,
    });
  if (session) {
    session.outboundQueue.enqueue({
      taskId: effectiveTaskId,
      label: "subagent-text-complete",
      delayMs: terminalFrameDelayMs,
      send: sendTextComplete,
    });
    if (pendingReferences.length > 0) {
      session.outboundQueue.enqueue({
        taskId: effectiveTaskId,
        label: "subagent-references",
        send: sendPendingReferences,
      });
    }
    session.outboundQueue.enqueue({
      taskId: effectiveTaskId,
      label: "subagent-summary-card",
      send: sendSummaryCard,
    });
    session.outboundQueue.enqueue({
      taskId: effectiveTaskId,
      label: "subagent-task-card-final",
      send: sendTaskCardFinal,
    });
    session.outboundQueue.enqueue({
      taskId: effectiveTaskId,
      label: "subagent-final",
      delayMs: terminalFrameDelayMs,
      send: sendFinal,
    });
    await session.outboundQueue.whenIdle();
  } else {
    await sendTextComplete();
    if (pendingReferences.length > 0) {
      await sendPendingReferences();
    }
    await sendSummaryCard();
    await sendTaskCardFinal();
    await sendFinal();
  }

  clearWaitState(state.sessionId, reason ?? "all-subagent-results-delivered", state.taskId);
  // 清理整个任务链（无 expectedTaskId），避免 steer 引入的额外 taskId 残留。
  completeTask(state.sessionId);
  setSessionState(state.sessionId, "completed");
  log.log(`[SUBAGENT-FINAL] Subagent final delivered, reason=${reason}, effectiveTaskId=${effectiveTaskId}`);
}

// Session context propagation via AsyncLocalStorage (JS ThreadLocal equivalent).
//
// Design: the entire agent turn (dispatchReplyFromConfig → tool.execute →
// provider.wrapStreamFn) is one async chain originating inside
// runWithSessionContext(ctx, ...) in bot.ts. ALS propagates the SessionContext
// through every awaited step, so tool.execute and provider HTTP headers read
// the per-turn ctx without any global Map / refCount / TTL machinery.
//
// cron/定时任务不走 ALS: openclaw 的 cron runner 同步调 agentTools({cfg})
// 返回工具后才在别处跑 turn, xy_channel 没有 wrap 整个 turn 的点。
// cron 工具调用走 sendCommand/push 通道, 靠闭包捕获的合成 ctx 即可,
// 不需要 getCurrentSessionContext。所以这里不保留任何全局回退。
import { AsyncLocalStorage } from "async_hooks";
import type { RunCrossTaskContext, SentFileCard, XYChannelConfig } from "../types.js";
import { logger } from "../utils/logger.js";
import { getCurrentTaskId, getCurrentMessageId } from "../task-manager.js";

export interface SessionContext {
  config: XYChannelConfig;
  sessionId: string;
  distributionSessionId?: string;
  taskId: string;
  messageId: string;
  agentId: string;
  deviceType?: string;
  /** Model name extracted from A2A user variables (variables.clientVariables.modelName).
   *  When set, provider.ts replaces model.id in the OpenAI request body. */
  modelName?: string;
  runCrossTaskContext?: RunCrossTaskContext;
  /** When true, this context was created for a cron/scheduled task execution.
   *  Tools should use the push channel instead of WebSocket sendCommand. */
  isCron?: boolean;
}

const _g = globalThis as Record<string, unknown>;

// ── Cron tool-call tracking ─────────────────────────────────────────
// Global Map keyed by toolCallId to track whether a specific tool call
// originated from a cron/scheduled task.  Populated by the
// `before_tool_call` hook (which receives openclaw's sessionKey with
// "cron:" prefix), consumed by sendCommand() to route through push channel.
// This is keyed by toolCallId (not "current session"), so it is NOT the
// session-context global being removed — it stays.
if (!_g.__xyCronToolCallMap) {
  _g.__xyCronToolCallMap = new Map<string, boolean>();
}
const cronToolCallMap = _g.__xyCronToolCallMap as Map<string, boolean>;

/** Mark a toolCallId as originating from a cron trigger. */
export function markCronToolCall(toolCallId: string): void {
  cronToolCallMap.set(toolCallId, true);
}

/** Check whether a toolCallId is from a cron trigger. */
export function isCronToolCall(toolCallId?: string): boolean {
  if (!toolCallId) return false;
  return cronToolCallMap.get(toolCallId) === true;
}

/** Clean up a cron tool call marker after use. */
export function clearCronToolCall(toolCallId: string): void {
  cronToolCallMap.delete(toolCallId);
}

// ── Cron session ↔ jobId bridge ────────────────────────────────────
// fire 期 jobId 传递桥。provider.ts 在 isCron 分支从首条消息
// `[cron:<jobId> ...]` 解析出真实 jobId，写入合成 cron sessionId；
// sendCommand/formatter 凭同一合成 sessionId 反查 jobId，再去
// cron-push-map 取对应设备的 pushId。同一 cron run 内 ALS 上下文共享，
// 合成 sessionId 在 provider 与 sendCommand 之间一致。
if (!_g.__xyCronSessionJobId) {
  _g.__xyCronSessionJobId = new Map<string, string>();
}
const cronSessionJobIdMap = _g.__xyCronSessionJobId as Map<string, string>;

/** 把 fire 期解析出的 jobId 绑定到当前 cron run 的合成 sessionId。 */
export function setCurrentCronJobId(cronSessionId: string, jobId: string): void {
  if (cronSessionId && jobId) {
    cronSessionJobIdMap.set(cronSessionId, jobId);
  }
}

/** 凭合成 cron sessionId 取本次 run 的 jobId（供 sendCommand 反查 pushId）。 */
export function getCurrentCronJobId(cronSessionId?: string): string | undefined {
  if (!cronSessionId) return undefined;
  return cronSessionJobIdMap.get(cronSessionId);
}

/** cron run 结束后清理。 */
export function clearCronJobId(cronSessionId: string): void {
  cronSessionJobIdMap.delete(cronSessionId);
}

// ── AsyncLocalStorage: the single source of truth for session context ──
// Exported on globalThis so logger.ts can read it without a circular import
// (session-manager imports logger for the [ALS-PROOF] log below).
if (!_g.__xyAsyncLocalStorage) {
  _g.__xyAsyncLocalStorage = new AsyncLocalStorage<SessionContext>();
}
export const asyncLocalStorage = _g.__xyAsyncLocalStorage as AsyncLocalStorage<SessionContext>;

/**
 * Run a callback with a session context stored in AsyncLocalStorage.
 * The ctx propagates through every `await` in the callback, including
 * openclaw's tool execution and provider HTTP calls.
 */
export function runWithSessionContext<T>(
  context: SessionContext,
  callback: () => Promise<T>,
): Promise<T> {
  return asyncLocalStorage.run(context, callback);
}

/**
 * Get the current session context from AsyncLocalStorage.
 *
 * Pure ALS — no global Map fallback. Returns null when called outside a
 * runWithSessionContext scope (e.g. cron path, gateway startup). Every read
 * is logged under [ALS-PROOF] so test runs can verify propagation.
 */
export function getCurrentSessionContext(): SessionContext | null {
  const ctx = asyncLocalStorage.getStore() ?? null;
  if (ctx) {
    const latestTaskId = getCurrentTaskId(ctx.sessionId);
    const latestMessageId = getCurrentMessageId(ctx.sessionId);
    if (latestTaskId && latestTaskId !== ctx.taskId) {
      logger.log(
        `[ALS-PROOF] getCurrentSessionContext ALS hit (enriched) sessionId=${ctx.sessionId} ` +
        `taskId=${ctx.taskId}→${latestTaskId}`,
      );
      return { ...ctx, taskId: latestTaskId, messageId: latestMessageId ?? ctx.messageId };
    }
    logger.log(
      `[ALS-PROOF] getCurrentSessionContext ALS hit sessionId=${ctx.sessionId} taskId=${ctx.taskId}`,
    );
    return ctx;
  }
  logger.log(`[ALS-PROOF] getCurrentSessionContext ALS miss (no active scope)`);
  return null;
}

function normalizeSentFileCard(card: SentFileCard): SentFileCard | null {
  if (!card || typeof card !== "object") {
    return null;
  }

  const fileName = typeof card.fileName === "string" ? card.fileName.trim() : "";
  const fileId = typeof card.fileId === "string" ? card.fileId.trim() : "";
  const mimeType = typeof card.mimeType === "string" ? card.mimeType.trim() : "";
  if (!fileName || !fileId) {
    return null;
  }

  return {
    fileName,
    fileId,
    ...(mimeType ? { mimeType } : {}),
  };
}

function dedupeSentFilesByFileId(existing: SentFileCard[], incoming: SentFileCard[]): SentFileCard[] {
  const knownFileIds = new Set<string>();
  for (const card of existing) {
    if (card.fileId) {
      knownFileIds.add(card.fileId);
    }
  }

  return incoming.filter((card) => {
    if (knownFileIds.has(card.fileId)) {
      return false;
    }
    knownFileIds.add(card.fileId);
    return true;
  });
}

export function appendRunCrossTaskSentFiles(
  sentFiles: SentFileCard[],
  explicitRunCrossTaskContext?: RunCrossTaskContext,
): SentFileCard[] {
  // ALS only — no global Map to sync.
  const context = asyncLocalStorage.getStore() ?? null;
  const runCrossTaskContext = explicitRunCrossTaskContext ?? context?.runCrossTaskContext;
  const normalizedSentFiles = sentFiles
    .map((card) => normalizeSentFileCard(card))
    .filter((card): card is SentFileCard => card !== null);

  if (!runCrossTaskContext || normalizedSentFiles.length === 0) {
    return runCrossTaskContext?.sentFiles ?? [];
  }

  const existing = Array.isArray(runCrossTaskContext.sentFiles) ? runCrossTaskContext.sentFiles : [];
  const dedupedSentFiles = dedupeSentFilesByFileId(existing, normalizedSentFiles);
  const merged = [...existing, ...dedupedSentFiles];
  runCrossTaskContext.sentFiles = merged;

  return merged;
}

export function clearRunCrossTaskSentFiles(
  explicitRunCrossTaskContext?: RunCrossTaskContext,
): void {
  // ALS only — no global Map to sync.
  const context = asyncLocalStorage.getStore() ?? null;
  const runCrossTaskContext = explicitRunCrossTaskContext ?? context?.runCrossTaskContext;

  if (!runCrossTaskContext) {
    return;
  }

  runCrossTaskContext.sentFiles = [];
}


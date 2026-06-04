// Session manager for XY tool context
// Stores active session contexts that tools can access
import { AsyncLocalStorage } from "async_hooks";
import type { RunCrossTaskContext, SentFileCard, SentFileParams, XYChannelConfig } from "../types.js";
import { logger } from "../utils/logger.js";
import { configManager } from "../utils/config-manager.js";
import { toolCallNudgeManager } from "../utils/tool-call-nudge-manager.js";
import { getCurrentTaskId, getCurrentMessageId } from "../task-manager.js";

export interface SessionContext {
  config: XYChannelConfig;
  sessionId: string;
  distributionSessionId?: string;
  taskId: string;
  messageId: string;
  agentId: string;
  deviceType?: string;
  runCrossTaskContext?: RunCrossTaskContext;
  /** When true, this context was created for a cron/scheduled task execution.
   *  Tools should use the push channel instead of WebSocket sendCommand. */
  isCron?: boolean;
}

/** 最大 session 存活时间（毫秒），超过此时间且无新消息的 session 视为僵尸。
 *  仅用于全局 Map 回退路径的清理，不影响 ALS 路径。
 *  工具已改为闭包捕获 ctx，此 TTL 仅作为防止 session 泄漏的最后防线。
 *  正常对话中 registerSession 会刷新 createdAt，所以长对话不受影响。 */
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface SessionContextWithRef extends SessionContext {
  refCount: number;  // 引用计数
  createdAt: number;  // 创建时间戳，用于过期检查
}

// Use globalThis to ensure a single Map instance across all module copies.
// The xy_channel plugin may be loaded by openclaw from different module resolution
// paths (plugin entry vs tool registration), causing session-manager.ts to be
// instantiated multiple times. globalThis guarantees all code shares the same Map.
const _g = globalThis as Record<string, unknown>;
if (!_g.__xyActiveSessions) {
  _g.__xyActiveSessions = new Map<string, SessionContextWithRef>();
}
export const activeSessions = _g.__xyActiveSessions as Map<string, SessionContextWithRef>;

// Track the most recently registered sessionKey for reliable fallback
// when AsyncLocalStorage context is lost across openclaw's embedded runner boundary.
if (!_g.__xyLastRegisteredSessionKey) {
  _g.__xyLastRegisteredSessionKey = "";
}
const getLastRegisteredKey = () => _g.__xyLastRegisteredSessionKey as string;
const setLastRegisteredKey = (key: string) => { _g.__xyLastRegisteredSessionKey = key; };

// ── Cron tool-call tracking ─────────────────────────────────────────
// Global Map keyed by toolCallId to track whether a specific tool call
// originated from a cron/scheduled task.  Populated by the
// `before_tool_call` hook (which receives openclaw's sessionKey with
// "cron:" prefix), consumed by sendCommand() to route through push channel.
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

// AsyncLocalStorage for thread-safe session context isolation
export const asyncLocalStorage = new AsyncLocalStorage<SessionContext>();

// Export AsyncLocalStorage to globalThis so logger.ts can access it
// without creating a circular dependency (session-manager imports logger)
if (!_g.__xyAsyncLocalStorage) {
  _g.__xyAsyncLocalStorage = asyncLocalStorage;
}

/**
 * Register a session context for tool access.
 * Should be called when starting to process a message.
 */
export function registerSession(sessionKey: string, context: SessionContext): void {
  // Track last registered session for reliable ALS-miss fallback
  setLastRegisteredKey(sessionKey);

  const existing = activeSessions.get(sessionKey);
  if (existing) {
    // 更新上下文，增加引用计数，刷新存活时间
    existing.taskId = context.taskId;
    existing.messageId = context.messageId;
    existing.refCount++;
    existing.createdAt = Date.now();  // 刷新存活时间，长对话不受 TTL 影响
  } else {
    // 新建
    activeSessions.set(sessionKey, {
      ...context,
      refCount: 1,
      createdAt: Date.now(),
    });
  }

}

/**
 * Unregister a session context.
 * Should be called when message processing is complete.
 */
export function unregisterSession(sessionKey: string): void {

  const existing = activeSessions.get(sessionKey);
  if (!existing) {
    return;
  }

  existing.refCount--;

  if (existing.refCount <= 0) {
    activeSessions.delete(sessionKey);
    configManager.clearSession(existing.sessionId);
    toolCallNudgeManager.clearSession(sessionKey);
  }

}

/**
 * Get session context by sessionKey.
 * Returns null if session not found.
 */
export function getSessionContext(sessionKey: string): SessionContext | null {

  const contextWithRef = activeSessions.get(sessionKey) ?? null;

  if (contextWithRef) {
    // 返回时去掉refCount字段
    const { refCount, createdAt, ...context } = contextWithRef;
    return context;
  }

  return null;
}

/**
 * Get the most recent session context.
 * @deprecated Use getCurrentSessionContext() instead for thread-safe access.
 * This is a fallback for tools that don't have access to sessionKey.
 * Returns null if no sessions are active.
 */
export function getLatestSessionContext(): SessionContext | null {

  if (activeSessions.size === 0) {
    return null;
  }

  // Return the last added session
  const sessions = Array.from(activeSessions.values());
  const latestSessionWithRef = sessions[sessions.length - 1];


  // 返回时去掉refCount字段
  const { refCount, createdAt, ...latestSession } = latestSessionWithRef;
  return latestSession;
}

/**
 * Run a callback with a session context stored in AsyncLocalStorage.
 * This ensures thread-safe context isolation for concurrent requests.
 */
export function runWithSessionContext<T>(
  context: SessionContext,
  callback: () => Promise<T>
): Promise<T> {
  return asyncLocalStorage.run(context, callback);
}

/**
 * Get the current session context.
 * Prefers AsyncLocalStorage (correct for concurrent sessions).
 * Falls back to the global activeSessions Map when AsyncLocalStorage
 * context is lost (e.g., pi-agent framework tool execution boundary).
 *
 * @param sessionKey - Optional exact sessionKey for precise lookup.
 *   When provided and AsyncLocalStorage is unavailable, this avoids
 *   ambiguous multi-session matching.
 */
export function getCurrentSessionContext(sessionKey?: string): SessionContext | null {
  // 1. Try AsyncLocalStorage first (correct for concurrent sessions)
  const alsContext = asyncLocalStorage.getStore() ?? null;
  if (alsContext) {
    return enrichWithLatestTaskInfo(alsContext);
  }

  // 2. Fallback: look up from global activeSessions Map
  if (activeSessions.size === 0) {
    return null;
  }

  // 2a. Exact sessionKey match (highest confidence fallback)
  if (sessionKey) {
    const exact = activeSessions.get(sessionKey);
    if (exact) {
      const { refCount, createdAt, ...context } = exact;
      return enrichWithLatestTaskInfo(context);
    }
    // sessionKey provided but not found — don't fall back to heuristics
    return null;
  }

  // 2b. Single active session — return it directly (but check TTL)
  if (activeSessions.size === 1) {
    const entry = activeSessions.values().next().value;
    if (entry) {
      // Check if session is stale
      if (Date.now() - entry.createdAt > SESSION_TTL_MS) {
        activeSessions.clear();
        return null;
      }
      const { refCount, createdAt, ...context } = entry;
      return enrichWithLatestTaskInfo(context);
    }
    return null;
  }

  // 2c. Multiple sessions — prefer the last registered session.
  // This is the most reliable heuristic when ALS is lost across openclaw's
  // embedded runner boundary: registerSession() is called just before
  // runWithSessionContext(), and agentTools() is called during tool
  // compilation shortly after. The last registered session is always the
  // one currently being set up.
  const lastKey = getLastRegisteredKey();
  if (lastKey) {
    const lastEntry = activeSessions.get(lastKey);
    if (lastEntry) {
      const { refCount, createdAt, ...context } = lastEntry;
      return enrichWithLatestTaskInfo(context);
    }
  }

  // 2d. Fallback: find any non-stale session
  const now = Date.now();
  for (const [key, entry] of activeSessions) {
    if (now - entry.createdAt > SESSION_TTL_MS) {
      configManager.clearSession(entry.sessionId);
      toolCallNudgeManager.clearSession(key);
      activeSessions.delete(key);
      continue;
    }
    const { refCount, createdAt, ...context } = entry;
    return enrichWithLatestTaskInfo(context);
  }

  return null;
}

/**
 * Force-clean all active sessions. Used during gateway shutdown/reload.
 */
export function cleanupAllSessions(): void {
  for (const [key, entry] of activeSessions) {
    configManager.clearSession(entry.sessionId);
    toolCallNudgeManager.clearSession(key);
  }
  activeSessions.clear();
}

/**
 * Clean up sessions that have exceeded TTL.
 * Returns the number of cleaned sessions.
 */
export function cleanupStaleSessions(): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of activeSessions) {
    if (now - entry.createdAt > SESSION_TTL_MS) {
      configManager.clearSession(entry.sessionId);
      toolCallNudgeManager.clearSession(key);
      activeSessions.delete(key);
      cleaned++;
    }
  }
  return cleaned;
}

/**
 * Get the current number of active sessions (for diagnostics).
 */
export function getActiveSessionCount(): number {
  return activeSessions.size;
}

function normalizeSentFileParams(params: SentFileParams): SentFileParams | null {
  const fileCards = Array.isArray(params.fileCards)
    ? params.fileCards
      .map((card): SentFileCard | null => {
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
      })
      .filter((card): card is SentFileCard => card !== null)
    : [];
  if (fileCards.length === 0) {
    return null;
  }

  return {
    fileCards,
  };
}

function hasSentFileContent(params: SentFileParams): boolean {
  return (params.fileCards?.length ?? 0) > 0;
}

function dedupeSentFilesByFileId(existing: SentFileParams[], incoming: SentFileParams[]): SentFileParams[] {
  const knownFileIds = new Set<string>();
  for (const params of existing) {
    for (const card of params.fileCards ?? []) {
      if (card.fileId) {
        knownFileIds.add(card.fileId);
      }
    }
  }

  return incoming
    .map((params): SentFileParams | null => {
      if (!params.fileCards?.length) {
        return params;
      }

      const fileCards = params.fileCards.filter((card) => {
        if (knownFileIds.has(card.fileId)) {
          return false;
        }
        knownFileIds.add(card.fileId);
        return true;
      });

      const deduped: SentFileParams = {
        ...(fileCards.length > 0 ? { fileCards } : {}),
      };

      return hasSentFileContent(deduped) ? deduped : null;
    })
    .filter((params): params is SentFileParams => params !== null);
}

export function appendRunCrossTaskSentFiles(
  sentFiles: SentFileParams[],
  explicitRunCrossTaskContext?: RunCrossTaskContext,
): SentFileParams[] {
  const context = asyncLocalStorage.getStore() ?? null;
  const runCrossTaskContext = explicitRunCrossTaskContext ?? context?.runCrossTaskContext;
  const normalizedSentFiles = sentFiles
    .map((params) => normalizeSentFileParams(params))
    .filter((params): params is SentFileParams => params !== null);

  if (!runCrossTaskContext || normalizedSentFiles.length === 0) {
    return runCrossTaskContext?.sentFiles ?? [];
  }

  const existing = Array.isArray(runCrossTaskContext.sentFiles) ? runCrossTaskContext.sentFiles : [];
  const dedupedSentFiles = dedupeSentFilesByFileId(existing, normalizedSentFiles);
  const merged = [...existing, ...dedupedSentFiles];
  runCrossTaskContext.sentFiles = merged;

  const sessionWithRef = Array.from(activeSessions.values()).find(
    (session) => session.runCrossTaskContext === runCrossTaskContext,
  );
  if (sessionWithRef?.runCrossTaskContext) {
    sessionWithRef.runCrossTaskContext.sentFiles = merged;
  }

  return merged;
}

export function clearRunCrossTaskSentFiles(
  explicitRunCrossTaskContext?: RunCrossTaskContext,
): void {
  const context = asyncLocalStorage.getStore() ?? null;
  const runCrossTaskContext = explicitRunCrossTaskContext ?? context?.runCrossTaskContext;

  if (!runCrossTaskContext) {
    return;
  }

  runCrossTaskContext.sentFiles = [];

  for (const sessionWithRef of activeSessions.values()) {
    if (sessionWithRef.runCrossTaskContext === runCrossTaskContext) {
      sessionWithRef.runCrossTaskContext.sentFiles = [];
    }
  }
}

/**
 * Enrich a base session context with the latest taskId/messageId
 * from task-manager (supports interruption scenarios).
 */
function enrichWithLatestTaskInfo(context: SessionContext): SessionContext {
  const latestTaskId = getCurrentTaskId(context.sessionId);
  const latestMessageId = getCurrentMessageId(context.sessionId);

  if (latestTaskId && latestTaskId !== context.taskId) {
    return {
      ...context,
      taskId: latestTaskId,
      messageId: latestMessageId ?? context.messageId,
    };
  }

  return context;
}

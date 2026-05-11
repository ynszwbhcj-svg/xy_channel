/**
 * XYSessionStore — unified session state management.
 *
 * Replaces the old session-manager.ts + task-manager.ts + tool-context.ts
 * with a single Map<sessionKey, XYSession>.
 *
 * Design:
 *   - Closures in tools/providers capture only `sessionKey` (a string).
 *   - Actual values (taskId, messageId, …) are looked up at execution time
 *     so steer-mode updates are always visible.
 *   - No refCount / lock — cleanup is driven by onSettled callbacks.
 *   - globalThis protection guards against duplicate module instances.
 */
import type { XYChannelConfig } from "./types.js";
import { logger } from "./utils/logger.js";
import { AsyncLocalStorage } from "node:async_hooks";

// ── Public types ──────────────────────────────────────────────

export interface XYSession {
  config: XYChannelConfig;
  /** A2A protocol sessionId — identifies the conversation. */
  a2aSessionId: string;
  /** A2A taskId — updated in-place on steer. */
  taskId: string;
  /** A2A messageId — updated in-place on steer. */
  messageId: string;
  /** Device type (phone / tablet / 2in1). */
  deviceType?: string;
  /** OpenClaw accountId from route resolution ("default"). */
  accountId: string;
}

export interface XYSessionALSContext {
  openclawSessionKey: string;
}

// ── AsyncLocalStorage ─────────────────────────────────────────
// Used by bot.ts to carry sessionKey through the agent run so
// channel.ts agentTools factory can read it.

export const xyAsyncLocalStorage = new AsyncLocalStorage<XYSessionALSContext>();

// ── Internal storage ──────────────────────────────────────────

interface StoredSession extends XYSession {
  createdAt: number;
}

const STORE_KEY = "__xySessionStore";
const A2A_INDEX_KEY = "__xyA2ASessionIndex";

const _g = globalThis as Record<string, unknown>;

function getStore(): Map<string, StoredSession> {
  if (!_g[STORE_KEY]) {
    _g[STORE_KEY] = new Map<string, StoredSession>();
  }
  return _g[STORE_KEY] as Map<string, StoredSession>;
}

/** Reverse index: a2aSessionId → openclawSessionKey (for provider lookups). */
function getA2AIndex(): Map<string, string> {
  if (!_g[A2A_INDEX_KEY]) {
    _g[A2A_INDEX_KEY] = new Map<string, string>();
  }
  return _g[A2A_INDEX_KEY] as Map<string, string>;
}

// ── API ───────────────────────────────────────────────────────

/**
 * Register or update a session.
 * Called from bot.ts after resolveAgentRoute().
 */
export function registerSession(
  sessionKey: string,
  session: XYSession,
): void {
  const store = getStore();
  const a2aIndex = getA2AIndex();

  const existing = store.get(sessionKey);
  if (existing) {
    // Update in place — steer mode
    existing.taskId = session.taskId;
    existing.messageId = session.messageId;
    existing.deviceType = session.deviceType;
    existing.createdAt = Date.now();
    logger.log(
      `[SESSION-STORE] update: sessionKey=${sessionKey} a2a=${session.a2aSessionId} taskId=${session.taskId}`,
    );
  } else {
    store.set(sessionKey, { ...session, createdAt: Date.now() });
    a2aIndex.set(session.a2aSessionId, sessionKey);
    logger.log(
      `[SESSION-STORE] register: sessionKey=${sessionKey} a2a=${session.a2aSessionId} taskId=${session.taskId}`,
    );
  }
}

/**
 * Update specific fields of an active session (used for steer).
 */
export function updateSession(
  sessionKey: string,
  partial: Partial<Pick<XYSession, "taskId" | "messageId" | "deviceType">>,
): void {
  const store = getStore();
  const entry = store.get(sessionKey);
  if (!entry) {
    logger.log(`[SESSION-STORE] update skipped: sessionKey=${sessionKey} not found`);
    return;
  }
  if (partial.taskId !== undefined) entry.taskId = partial.taskId;
  if (partial.messageId !== undefined) entry.messageId = partial.messageId;
  if (partial.deviceType !== undefined) entry.deviceType = partial.deviceType;
  logger.log(
    `[SESSION-STORE] update: sessionKey=${sessionKey} taskId=${entry.taskId}`,
  );
}

/**
 * Get session by OpenClaw sessionKey.
 * Returns null if not found.
 */
export function getSession(sessionKey: string): XYSession | null {
  const store = getStore();
  const entry = store.get(sessionKey);
  if (!entry) return null;
  // Strip internal fields
  const { createdAt, ...session } = entry;
  return session;
}

/**
 * Get session by A2A sessionId.
 * Used by provider.ts which only knows the A2A sessionId.
 */
export function getSessionByA2AId(a2aSessionId: string): XYSession | null {
  const a2aIndex = getA2AIndex();
  const sessionKey = a2aIndex.get(a2aSessionId);
  if (!sessionKey) return null;
  return getSession(sessionKey);
}

/**
 * Unregister a session. Called from onSettled / error cleanup.
 */
export function unregisterSession(sessionKey: string): void {
  const store = getStore();
  const a2aIndex = getA2AIndex();
  const entry = store.get(sessionKey);
  if (!entry) return;

  a2aIndex.delete(entry.a2aSessionId);
  store.delete(sessionKey);
  logger.log(`[SESSION-STORE] unregister: sessionKey=${sessionKey}`);
}

/**
 * Check whether a session has an active task (used for steer detection).
 */
export function hasActiveSession(sessionKey: string): boolean {
  return getStore().has(sessionKey);
}

/**
 * Get all active sessions (for gateway stop / diagnostics).
 */
export function getAllActiveSessions(): Array<{ sessionKey: string; session: XYSession }> {
  const store = getStore();
  const result: Array<{ sessionKey: string; session: XYSession }> = [];
  for (const [key, entry] of store) {
    const { createdAt, ...session } = entry;
    result.push({ sessionKey: key, session });
  }
  return result;
}

/**
 * Get count of active sessions.
 */
export function getActiveSessionCount(): number {
  return getStore().size;
}

/**
 * Force-clean all sessions (gateway shutdown / reload).
 */
export function cleanupAllSessions(): void {
  getStore().clear();
  getA2AIndex().clear();
  logger.log("[SESSION-STORE] all sessions cleaned up");
}

/**
 * Clean up stale sessions (older than TTL).
 * Returns number of cleaned sessions.
 */
export function cleanupStaleSessions(ttlMs = 60 * 60 * 1000): number {
  const store = getStore();
  const a2aIndex = getA2AIndex();
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of store) {
    if (now - entry.createdAt > ttlMs) {
      a2aIndex.delete(entry.a2aSessionId);
      store.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logger.log(`[SESSION-STORE] cleaned ${cleaned} stale session(s)`);
  }
  return cleaned;
}


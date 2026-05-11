/**
 * Tool session helper — provides a simple API for tools to access
 * the current session context via sessionKey.
 *
 * Tools capture `sessionKey` at creation time (may be empty if ALS
 * was not available at agentTools factory time) and call
 * `requireSession()` at execute time. If the captured sessionKey
 * doesn't resolve, we fall back to ALS — the agent run is always
 * within the ALS context set by bot.ts.
 */
import { getSession, xyAsyncLocalStorage, type XYSession } from "../xy-session-store.js";

/**
 * Get the session for a sessionKey, throwing if not found.
 * Falls back to ALS lookup when sessionKey is empty or stale.
 * Used at the top of every tool's execute() to get live context.
 */
export function requireSession(sessionKey?: string | null): XYSession {
  // Try explicit sessionKey first
  if (sessionKey) {
    const session = getSession(sessionKey);
    if (session) return session;
  }
  // Fallback to ALS — available at execute time (bot.ts sets it before the agent run)
  const alsContext = xyAsyncLocalStorage.getStore();
  const key = alsContext?.openclawSessionKey;
  if (key) {
    const session = getSession(key);
    if (session) return session;
  }
  throw new Error(`XY session not found (sessionKey=${sessionKey ?? "none"}, alsKey=${key ?? "none"})`);
}

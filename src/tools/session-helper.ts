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
import { getSession, xyAsyncLocalStorage, getAllActiveSessions, type XYSession } from "../xy-session-store.js";

/**
 * Get the session for a sessionKey, throwing if not found.
 *
 * Resolution order:
 *   1. Closure-captured sessionKey (set at agentTools factory time)
 *   2. ALS (set by bot.ts before the agent run)
 *   3. Store enumeration — safe only when a single session is active
 *
 * Layers 1 and 2 can both fail: agentTools may be called before ALS is
 * active, and pi-agent-core tool execute may cross async boundaries that
 * lose the ALS context.  Layer 3 is the ultimate fallback.
 */
export function requireSession(sessionKey?: string | null): XYSession {
  // Layer 1: closure-captured sessionKey
  if (sessionKey) {
    const session = getSession(sessionKey);
    if (session) return session;
  }

  // Layer 2: ALS (works when the async chain preserves the context)
  const alsContext = xyAsyncLocalStorage.getStore();
  const alsKey = alsContext?.openclawSessionKey;
  if (alsKey) {
    const session = getSession(alsKey);
    if (session) return session;
  }

  // Layer 3: store enumeration — reliable when only one session is active
  const allSessions = getAllActiveSessions();
  if (allSessions.length === 1) {
    return allSessions[0].session;
  }

  throw new Error(
    `XY session not found (sessionKey=${sessionKey ?? "none"}, alsKey=${alsKey ?? "none"}, activeSessions=${allSessions.length})`,
  );
}

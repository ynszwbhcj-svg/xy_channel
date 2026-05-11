/**
 * Tool session helper — provides a simple API for tools to access
 * the current session context via sessionKey.
 *
 * Tools capture `sessionKey` at creation time and call `requireSession()`
 * at execute time to get the live XYSession (with latest taskId).
 */
import { getSession, type XYSession } from "../xy-session-store.js";

/**
 * Get the session for a sessionKey, throwing if not found.
 * Used at the top of every tool's execute() to get live context.
 */
export function requireSession(sessionKey: string): XYSession {
  const session = getSession(sessionKey);
  if (!session) {
    throw new Error(`XY session not found for key: ${sessionKey}`);
  }
  return session;
}

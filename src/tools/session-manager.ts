// Session manager for XY tool context
// Stores active session contexts that tools can access
import type { XYChannelConfig } from "../types.js";

export interface SessionContext {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  agentId: string;
}

// Map of sessionKey -> SessionContext
const activeSessions = new Map<string, SessionContext>();

/**
 * Register a session context for tool access.
 * Should be called when starting to process a message.
 */
export function registerSession(sessionKey: string, context: SessionContext): void {
  activeSessions.set(sessionKey, context);
}

/**
 * Unregister a session context.
 * Should be called when message processing is complete.
 */
export function unregisterSession(sessionKey: string): void {
  activeSessions.delete(sessionKey);
}

/**
 * Get session context by sessionKey.
 * Returns null if session not found.
 */
export function getSessionContext(sessionKey: string): SessionContext | null {
  return activeSessions.get(sessionKey) ?? null;
}

/**
 * Get the most recent session context.
 * This is a fallback for tools that don't have access to sessionKey.
 * Returns null if no sessions are active.
 */
export function getLatestSessionContext(): SessionContext | null {
  if (activeSessions.size === 0) return null;
  // Return the last added session
  const sessions = Array.from(activeSessions.values());
  return sessions[sessions.length - 1];
}

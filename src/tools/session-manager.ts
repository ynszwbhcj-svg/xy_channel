// Session manager for XY tool context
// Stores active session contexts that tools can access
import type { XYChannelConfig } from "../types.js";
import { logger } from "../utils/logger.js";
import { configManager } from "../utils/config-manager.js";

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
  logger.log(`[SESSION_MANAGER] 📝 Registering session: ${sessionKey}`);
  logger.log(`[SESSION_MANAGER]   - sessionId: ${context.sessionId}`);
  logger.log(`[SESSION_MANAGER]   - taskId: ${context.taskId}`);
  logger.log(`[SESSION_MANAGER]   - messageId: ${context.messageId}`);
  logger.log(`[SESSION_MANAGER]   - agentId: ${context.agentId}`);
  logger.log(`[SESSION_MANAGER]   - Active sessions before: ${activeSessions.size}`);

  activeSessions.set(sessionKey, context);

  logger.log(`[SESSION_MANAGER]   - Active sessions after: ${activeSessions.size}`);
  logger.log(`[SESSION_MANAGER]   - All session keys: [${Array.from(activeSessions.keys()).join(", ")}]`);
}

/**
 * Unregister a session context.
 * Should be called when message processing is complete.
 */
export function unregisterSession(sessionKey: string): void {
  logger.log(`[SESSION_MANAGER] 🗑️  Unregistering session: ${sessionKey}`);
  logger.log(`[SESSION_MANAGER]   - Active sessions before: ${activeSessions.size}`);
  logger.log(`[SESSION_MANAGER]   - Session existed: ${activeSessions.has(sessionKey)}`);

  // Get session context before deleting to clear associated pushId
  const context = activeSessions.get(sessionKey);
  const existed = activeSessions.delete(sessionKey);

  // Clear cached pushId for this session
  if (context) {
    configManager.clearSession(context.sessionId);
  }

  logger.log(`[SESSION_MANAGER]   - Deleted: ${existed}`);
  logger.log(`[SESSION_MANAGER]   - Active sessions after: ${activeSessions.size}`);
  logger.log(`[SESSION_MANAGER]   - Remaining session keys: [${Array.from(activeSessions.keys()).join(", ")}]`);
}

/**
 * Get session context by sessionKey.
 * Returns null if session not found.
 */
export function getSessionContext(sessionKey: string): SessionContext | null {
  logger.log(`[SESSION_MANAGER] 🔍 Getting session by key: ${sessionKey}`);
  logger.log(`[SESSION_MANAGER]   - Active sessions: ${activeSessions.size}`);

  const context = activeSessions.get(sessionKey) ?? null;

  logger.log(`[SESSION_MANAGER]   - Found: ${context !== null}`);
  if (context) {
    logger.log(`[SESSION_MANAGER]   - sessionId: ${context.sessionId}`);
  }

  return context;
}

/**
 * Get the most recent session context.
 * This is a fallback for tools that don't have access to sessionKey.
 * Returns null if no sessions are active.
 */
export function getLatestSessionContext(): SessionContext | null {
  logger.log(`[SESSION_MANAGER] 🔍 Getting latest session context`);
  logger.log(`[SESSION_MANAGER]   - Active sessions count: ${activeSessions.size}`);
  logger.log(`[SESSION_MANAGER]   - Active session keys: [${Array.from(activeSessions.keys()).join(", ")}]`);

  if (activeSessions.size === 0) {
    logger.error(`[SESSION_MANAGER]   - ❌ No active sessions found!`);
    return null;
  }

  // Return the last added session
  const sessions = Array.from(activeSessions.values());
  const latestSession = sessions[sessions.length - 1];

  logger.log(`[SESSION_MANAGER]   - ✅ Found latest session:`);
  logger.log(`[SESSION_MANAGER]     - sessionId: ${latestSession.sessionId}`);
  logger.log(`[SESSION_MANAGER]     - taskId: ${latestSession.taskId}`);
  logger.log(`[SESSION_MANAGER]     - messageId: ${latestSession.messageId}`);

  return latestSession;
}

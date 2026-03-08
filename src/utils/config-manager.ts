// Dynamic configuration manager for runtime updates
import { logger } from "./logger.js";

/**
 * Manages dynamic configuration updates that can change at runtime.
 * Specifically handles pushId which can be updated per-session.
 */
class ConfigManager {
  private sessionPushIds: Map<string, string> = new Map();
  private globalPushId: string | null = null;

  /**
   * Update push ID for a specific session.
   */
  updatePushId(sessionId: string, pushId: string): void {
    if (!pushId) {
      logger.warn(`[ConfigManager] Attempted to set empty pushId for session ${sessionId}`);
      return;
    }

    const previous = this.sessionPushIds.get(sessionId);
    if (previous !== pushId) {
      logger.log(`[ConfigManager] ✨ Updated pushId for session ${sessionId}`);
      logger.log(`[ConfigManager]   - Previous: ${previous ? previous.substring(0, 20) + '...' : 'none'}`);
      logger.log(`[ConfigManager]   - New:      ${pushId.substring(0, 20)}...`);
      logger.log(`[ConfigManager]   - Full new pushId: ${pushId}`);
      this.sessionPushIds.set(sessionId, pushId);
      this.globalPushId = pushId; // Also update global for backward compatibility
    }
  }

  /**
   * Get push ID for a session (falls back to global if not found).
   */
  getPushId(sessionId?: string): string | null {
    if (sessionId) {
      const sessionPushId = this.sessionPushIds.get(sessionId);
      if (sessionPushId) {
        return sessionPushId;
      }
    }
    return this.globalPushId;
  }

  /**
   * Clear push ID for a session.
   */
  clearSession(sessionId: string): void {
    this.sessionPushIds.delete(sessionId);
    logger.debug(`[ConfigManager] Cleared pushId for session ${sessionId}`);
  }

  /**
   * Clear all cached push IDs.
   */
  clear(): void {
    this.sessionPushIds.clear();
    this.globalPushId = null;
    logger.debug(`[ConfigManager] Cleared all cached pushIds`);
  }
}

export const configManager = new ConfigManager();

// Dynamic configuration manager for runtime updates
//
// NOTE: xy_channel is loaded from multiple module resolution paths
// (plugin entry vs tool registration), which duplicates class instances.
// sessionPushIds and globalPushId must live on globalThis so all copies
// share the same Map — same reason activeSessions is on globalThis in
// session-manager.ts.
import { logger } from "./logger.js";

const _g = globalThis as Record<string, unknown>;

if (!_g.__xyConfigSessionPushIds) {
  _g.__xyConfigSessionPushIds = new Map<string, string>();
}
if (!_g.__xyConfigGlobalPushId) {
  _g.__xyConfigGlobalPushId = null;
}

/**
 * Manages dynamic configuration updates that can change at runtime.
 * Specifically handles pushId which can be updated per-session.
 */
class ConfigManager {
  private get sessionPushIds(): Map<string, string> {
    return _g.__xyConfigSessionPushIds as Map<string, string>;
  }
  private get globalPushId(): string | null {
    return _g.__xyConfigGlobalPushId as string | null;
  }
  private set globalPushId(value: string | null) {
    _g.__xyConfigGlobalPushId = value;
  }

  /**
   * Update push ID for a specific session.
   */
  updatePushId(sessionId: string, pushId: string): void {
    if (!pushId) {
      logger.warn(`[ConfigManager] Attempted to set empty pushId`);
      return;
    }

    const previous = this.sessionPushIds.get(sessionId);
    if (previous !== pushId) {
      logger.log(`[ConfigManager] Updated pushId: previous=${previous ? previous.substring(0, 20) : 'none'}, new=${pushId.substring(0, 20)}`);
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
    logger.debug(`[ConfigManager] Cleared pushId`);
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

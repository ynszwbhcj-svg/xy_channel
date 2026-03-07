// Session management utilities
import type { SessionBinding, ServerIdentifier } from "../types.js";

/**
 * Session-to-server binding cache.
 * Tracks which WebSocket server each session is bound to.
 */
class SessionManager {
  private bindings = new Map<string, SessionBinding>();

  /**
   * Bind a session to a specific server.
   */
  bind(sessionId: string, server: ServerIdentifier): void {
    this.bindings.set(sessionId, {
      sessionId,
      server,
      boundAt: Date.now(),
    });
  }

  /**
   * Get the server binding for a session.
   */
  getBinding(sessionId: string): ServerIdentifier | null {
    const binding = this.bindings.get(sessionId);
    return binding ? binding.server : null;
  }

  /**
   * Check if a session is bound to a server.
   */
  isBound(sessionId: string): boolean {
    return this.bindings.has(sessionId);
  }

  /**
   * Unbind a session.
   */
  unbind(sessionId: string): void {
    this.bindings.delete(sessionId);
  }

  /**
   * Clear all bindings.
   */
  clear(): void {
    this.bindings.clear();
  }

  /**
   * Get all bindings.
   */
  getAll(): SessionBinding[] {
    return Array.from(this.bindings.values());
  }
}

// Singleton instance
export const sessionManager = new SessionManager();

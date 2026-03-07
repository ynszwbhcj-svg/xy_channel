// Tool context management
// Legacy AsyncLocalStorage approach - replaced by session-manager.ts
// Keeping type definitions for compatibility
import type { XYChannelConfig } from "../types.js";

/**
 * Context data available to XY tools during execution.
 */
export interface XYToolContext {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  agentId: string;
}

/**
 * @deprecated Use session-manager.ts instead
 * Legacy function kept for compatibility
 */
export function getXYToolContext(): XYToolContext {
  throw new Error("getXYToolContext is deprecated. Tools should use session-manager.ts instead.");
}


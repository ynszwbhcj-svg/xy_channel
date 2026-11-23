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
export declare function getXYToolContext(): XYToolContext;

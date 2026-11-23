import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import type { XYChannelConfig } from "./types.js";
/**
 * Resolve and validate Xiaoyi channel configuration from ClawdbotConfig.
 * Simplified version - only supports single account (no multi-account management).
 */
export declare function resolveXYConfig(cfg: ClawdbotConfig): XYChannelConfig;
/**
 * List available account IDs.
 * Simplified - always returns single account "default".
 */
export declare function listXYAccountIds(): string[];
/**
 * Get default account ID.
 * Simplified - always returns "default".
 */
export declare function getDefaultXYAccountId(): string;

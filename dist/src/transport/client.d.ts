import { XYWebSocketManager } from "./websocket.js";
import type { XYChannelConfig } from "../types.js";
import type { RuntimeEnv } from "openclaw/plugin-sdk";
/**
 * Get a cached WebSocket manager without requiring config.
 * Returns the first available manager. Use when ALS has no SessionContext.
 */
export declare function getCachedXYWebSocketManager(): XYWebSocketManager;
/**
 * Get or create a WebSocket manager for the given configuration.
 * Reuses existing managers if config matches.
 */
export declare function getXYWebSocketManager(config: XYChannelConfig, runtime?: RuntimeEnv): XYWebSocketManager;
/**
 * Remove a specific WebSocket manager from cache.
 * Disconnects the manager and removes it from the cache.
 */
export declare function removeXYWebSocketManager(config: XYChannelConfig): void;
/**
 * Clear all cached WebSocket managers.
 */
export declare function clearXYWebSocketManagers(): void;
/**
 * Get the number of cached managers.
 */
export declare function getCachedManagerCount(): number;
/**
 * Diagnose all cached WebSocket managers.
 * Helps identify connection issues and orphan connections.
 */
export declare function diagnoseAllManagers(): void;
/**
 * Clean up orphan connections across all managers.
 * Returns the number of managers that had orphan connections.
 */
export declare function cleanupOrphanConnections(): number;

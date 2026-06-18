// WebSocket client cache management
// Follows feishu/client.ts pattern for caching client instances
import { XYWebSocketManager } from "./websocket.js";
import type { XYChannelConfig } from "./types.js";
import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { logger } from "./utils/logger.js";

/**
 * Global cache for WebSocket managers.
 * Key format: `${apiKey}-${agentId}`
 * Uses globalThis to ensure a single cache across all module copies
 * (same fix as session-manager.ts for openclaw multi-instance loading).
 */
const _g = globalThis as Record<string, unknown>;
if (!_g.__xyWsManagerCache) {
  _g.__xyWsManagerCache = new Map<string, XYWebSocketManager>();
}
const wsManagerCache = _g.__xyWsManagerCache as Map<string, XYWebSocketManager>;

/**
 * Get a cached WebSocket manager without requiring config.
 * Returns the first available manager. Use when ALS has no SessionContext.
 */
export function getCachedXYWebSocketManager(): XYWebSocketManager {
  if (wsManagerCache.size === 0) {
    throw new Error("No WebSocket manager available in cache");
  }
  return wsManagerCache.values().next().value!;
}

/**
 * Get or create a WebSocket manager for the given configuration.
 * Reuses existing managers if config matches.
 */
export function getXYWebSocketManager(config: XYChannelConfig, runtime?: RuntimeEnv): XYWebSocketManager {
  const cacheKey = `${config.apiKey}-${config.agentId}`;
  let cached = wsManagerCache.get(cacheKey);

  if (cached && cached.isConfigMatch(config)) {
    return cached;
  }

  // Create new manager
  logger.log(`[WS-MANAGER-CACHE] Creating new WebSocket manager: ${cacheKey}, total managers before: ${wsManagerCache.size}`);
  cached = new XYWebSocketManager(config, runtime);
  wsManagerCache.set(cacheKey, cached);
  logger.log(`[WS-MANAGER-CACHE] Total managers after creation: ${wsManagerCache.size}`);

  return cached;
}

/**
 * Remove a specific WebSocket manager from cache.
 * Disconnects the manager and removes it from the cache.
 */
export function removeXYWebSocketManager(config: XYChannelConfig): void {
  const cacheKey = `${config.apiKey}-${config.agentId}`;
  const manager = wsManagerCache.get(cacheKey);

  if (manager) {
    logger.log(`[WS-MANAGER-CACHE] Removing manager from cache: ${cacheKey}`);
    manager.disconnect();
    wsManagerCache.delete(cacheKey);
    logger.log(`[WS-MANAGER-CACHE] Manager removed, remaining managers: ${wsManagerCache.size}`);
  } else {
    logger.log(`[WS-MANAGER-CACHE] Manager not found in cache: ${cacheKey}`);
  }
}

/**
 * Clear all cached WebSocket managers.
 */
export function clearXYWebSocketManagers(): void {
  logger.log("Clearing all WebSocket manager caches");
  for (const manager of wsManagerCache.values()) {
    manager.disconnect();
  }
  wsManagerCache.clear();
}

/**
 * Get the number of cached managers.
 */
export function getCachedManagerCount(): number {
  return wsManagerCache.size;
}

/**
 * Diagnose all cached WebSocket managers.
 * Helps identify connection issues and orphan connections.
 */
export function diagnoseAllManagers(): void {
  logger.log(`[DIAG] Total cached managers: ${wsManagerCache.size}`);

  if (wsManagerCache.size === 0) {
    logger.log("[DIAG] No managers in cache");
    return;
  }

  let orphanCount = 0;

  wsManagerCache.forEach((manager, key) => {
    const diag = manager.getConnectionDiagnostics();
    logger.log(`[DIAG] Manager ${key} — event listeners: ${diag.totalEventListeners} | Connection: exists=${diag.connection.exists}, readyState=${diag.connection.readyState}, stateConnected=${diag.connection.stateConnected}/${diag.connection.stateReady}, reconnectAttempts=${diag.connection.reconnectAttempts}, wsListeners=${diag.connection.listenerCount}, heartbeatActive=${diag.connection.heartbeatActive}, hasReconnectTimer=${diag.connection.hasReconnectTimer}`);
    if (diag.connection.isOrphan) {
      logger.log(`[DIAG] ORPHAN CONNECTION DETECTED on manager: ${key}`);
      orphanCount++;
    }
  });

  if (orphanCount > 0) {
    logger.log(`[DIAG] Total orphan connections found: ${orphanCount} — these connections should be cleaned up`);
  } else {
    logger.log("[DIAG] No orphan connections found");
  }
}

/**
 * Clean up orphan connections across all managers.
 * Returns the number of managers that had orphan connections.
 */
export function cleanupOrphanConnections(): number {
  let cleanedCount = 0;

  wsManagerCache.forEach((manager, key) => {
    const diag = manager.getConnectionDiagnostics();

    if (diag.connection.isOrphan) {
      logger.log(`[CLEANUP] Cleaning up orphan connections in manager: ${key}`);
      manager.disconnect();
      cleanedCount++;
    }
  });

  if (cleanedCount > 0) {
    logger.log(`[CLEANUP] Cleaned up ${cleanedCount} manager(s) with orphan connections`);
  }

  return cleanedCount;
}

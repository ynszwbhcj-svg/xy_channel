// WebSocket client cache management
// Follows feishu/client.ts pattern for caching client instances
import { XYWebSocketManager } from "./websocket.js";
import type { XYChannelConfig } from "./types.js";
import type { RuntimeEnv } from "openclaw/plugin-sdk";

// Runtime reference for logging
let runtime: RuntimeEnv | undefined;

/**
 * Set the runtime for logging in client module.
 */
export function setClientRuntime(rt: RuntimeEnv | undefined): void {
  runtime = rt;
}

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
 * Get or create a WebSocket manager for the given configuration.
 * Reuses existing managers if config matches.
 */
export function getXYWebSocketManager(config: XYChannelConfig): XYWebSocketManager {
  const cacheKey = `${config.apiKey}-${config.agentId}`;
  let cached = wsManagerCache.get(cacheKey);

  if (cached && cached.isConfigMatch(config)) {
    const log = runtime?.log ?? console.log;
    return cached;
  }

  // Create new manager
  const log = runtime?.log ?? console.log;
  log(`[WS-MANAGER-CACHE] 🆕 Creating new WebSocket manager: ${cacheKey}, total managers before: ${wsManagerCache.size}`);
  cached = new XYWebSocketManager(config, runtime);
  wsManagerCache.set(cacheKey, cached);
  log(`[WS-MANAGER-CACHE] 📊 Total managers after creation: ${wsManagerCache.size}`);

  return cached;
}

/**
 * Remove a specific WebSocket manager from cache.
 * Disconnects the manager and removes it from the cache.
 */
export function removeXYWebSocketManager(config: XYChannelConfig): void {
  const log = runtime?.log ?? console.log;
  const cacheKey = `${config.apiKey}-${config.agentId}`;
  const manager = wsManagerCache.get(cacheKey);

  if (manager) {
    log(`🗑️  [WS-MANAGER-CACHE] Removing manager from cache: ${cacheKey}`);
    manager.disconnect();
    wsManagerCache.delete(cacheKey);
    log(`🗑️  [WS-MANAGER-CACHE] Manager removed, remaining managers: ${wsManagerCache.size}`);
  } else {
    log(`⚠️  [WS-MANAGER-CACHE] Manager not found in cache: ${cacheKey}`);
  }
}

/**
 * Clear all cached WebSocket managers.
 */
export function clearXYWebSocketManagers(): void {
  const log = runtime?.log ?? console.log;
  log("Clearing all WebSocket manager caches");
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
  const log = runtime?.log ?? console.log;
  log(`Total cached managers: ${wsManagerCache.size}`);

  if (wsManagerCache.size === 0) {
    log("ℹ️  No managers in cache");
    return;
  }

  let orphanCount = 0;

  wsManagerCache.forEach((manager, key) => {
    const diag = manager.getConnectionDiagnostics();
    log(`   Total event listeners on manager: ${diag.totalEventListeners}`);

    // Connection
    log(`   🔌 Connection:`);
    log(`      - Exists: ${diag.connection.exists}`);
    log(`      - ReadyState: ${diag.connection.readyState}`);
    log(`      - State connected/ready: ${diag.connection.stateConnected}/${diag.connection.stateReady}`);
    log(`      - Reconnect attempts: ${diag.connection.reconnectAttempts}`);
    log(`      - Listeners on WebSocket: ${diag.connection.listenerCount}`);
    log(`      - Heartbeat active: ${diag.connection.heartbeatActive}`);
    log(`      - Has reconnect timer: ${diag.connection.hasReconnectTimer}`);
    if (diag.connection.isOrphan) {
      log(`      ⚠️  ORPHAN CONNECTION DETECTED!`);
      orphanCount++;
    }

    log("");
  });

  if (orphanCount > 0) {
    log(`⚠️  Total orphan connections found: ${orphanCount}`);
    log(`💡 Suggestion: These connections should be cleaned up`);
  } else {
    log(`✅ No orphan connections found`);
  }
}

/**
 * Clean up orphan connections across all managers.
 * Returns the number of managers that had orphan connections.
 */
export function cleanupOrphanConnections(): number {
  const log = runtime?.log ?? console.log;
  let cleanedCount = 0;

  wsManagerCache.forEach((manager, key) => {
    const diag = manager.getConnectionDiagnostics();

    if (diag.connection.isOrphan) {
      log(`🧹 Cleaning up orphan connections in manager: ${key}`);
      manager.disconnect();
      cleanedCount++;
    }
  });

  if (cleanedCount > 0) {
    log(`🧹 Cleaned up ${cleanedCount} manager(s) with orphan connections`);
  }

  return cleanedCount;
}

// WebSocket client cache management
// Follows feishu/client.ts pattern for caching client instances
import { XYWebSocketManager } from "./websocket.js";
import type { XYChannelConfig } from "./types.js";
import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { getXYRuntime } from "./runtime.js";

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
 */
const wsManagerCache = new Map<string, XYWebSocketManager>();

/**
 * Get or create a WebSocket manager for the given configuration.
 * Reuses existing managers if config matches.
 */
export function getXYWebSocketManager(config: XYChannelConfig): XYWebSocketManager {
  const cacheKey = `${config.apiKey}-${config.agentId}`;
  let cached = wsManagerCache.get(cacheKey);

  if (cached && cached.isConfigMatch(config)) {
    const log = runtime?.log ?? console.log;
    log(`[WS-MANAGER-CACHE] ✅ Reusing cached WebSocket manager: ${cacheKey}, total managers: ${wsManagerCache.size}`);
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
  const cacheKey = `${config.apiKey}-${config.agentId}`;
  const manager = wsManagerCache.get(cacheKey);

  if (manager) {
    console.log(`🗑️  [WS-MANAGER-CACHE] Removing manager from cache: ${cacheKey}`);
    manager.disconnect();
    wsManagerCache.delete(cacheKey);
    console.log(`🗑️  [WS-MANAGER-CACHE] Manager removed, remaining managers: ${wsManagerCache.size}`);
  } else {
    console.log(`⚠️  [WS-MANAGER-CACHE] Manager not found in cache: ${cacheKey}`);
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
  console.log("========================================");
  console.log("📊 WebSocket Manager Global Diagnostics");
  console.log("========================================");
  console.log(`Total cached managers: ${wsManagerCache.size}`);
  console.log("");

  if (wsManagerCache.size === 0) {
    console.log("ℹ️  No managers in cache");
    console.log("========================================");
    return;
  }

  let orphanCount = 0;

  wsManagerCache.forEach((manager, key) => {
    const diag = manager.getConnectionDiagnostics();

    console.log(`📌 Manager: ${key}`);
    console.log(`   Shutting down: ${diag.isShuttingDown}`);
    console.log(`   Total event listeners on manager: ${diag.totalEventListeners}`);

    // Server 1
    console.log(`   🔌 Server1:`);
    console.log(`      - Exists: ${diag.server1.exists}`);
    console.log(`      - ReadyState: ${diag.server1.readyState}`);
    console.log(`      - State connected/ready: ${diag.server1.stateConnected}/${diag.server1.stateReady}`);
    console.log(`      - Reconnect attempts: ${diag.server1.reconnectAttempts}`);
    console.log(`      - Listeners on WebSocket: ${diag.server1.listenerCount}`);
    console.log(`      - Heartbeat active: ${diag.server1.heartbeatActive}`);
    console.log(`      - Has reconnect timer: ${diag.server1.hasReconnectTimer}`);
    if (diag.server1.isOrphan) {
      console.log(`      ⚠️  ORPHAN CONNECTION DETECTED!`);
      orphanCount++;
    }

    // Server 2
    console.log(`   🔌 Server2:`);
    console.log(`      - Exists: ${diag.server2.exists}`);
    console.log(`      - ReadyState: ${diag.server2.readyState}`);
    console.log(`      - State connected/ready: ${diag.server2.stateConnected}/${diag.server2.stateReady}`);
    console.log(`      - Reconnect attempts: ${diag.server2.reconnectAttempts}`);
    console.log(`      - Listeners on WebSocket: ${diag.server2.listenerCount}`);
    console.log(`      - Heartbeat active: ${diag.server2.heartbeatActive}`);
    console.log(`      - Has reconnect timer: ${diag.server2.hasReconnectTimer}`);
    if (diag.server2.isOrphan) {
      console.log(`      ⚠️  ORPHAN CONNECTION DETECTED!`);
      orphanCount++;
    }

    console.log("");
  });

  if (orphanCount > 0) {
    console.log(`⚠️  Total orphan connections found: ${orphanCount}`);
    console.log(`💡 Suggestion: These connections should be cleaned up`);
  } else {
    console.log(`✅ No orphan connections found`);
  }

  console.log("========================================");
}

/**
 * Clean up orphan connections across all managers.
 * Returns the number of managers that had orphan connections.
 */
export function cleanupOrphanConnections(): number {
  let cleanedCount = 0;

  wsManagerCache.forEach((manager, key) => {
    const diag = manager.getConnectionDiagnostics();

    if (diag.server1.isOrphan || diag.server2.isOrphan) {
      console.log(`🧹 Cleaning up orphan connections in manager: ${key}`);
      manager.disconnect();
      cleanedCount++;
    }
  });

  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned up ${cleanedCount} manager(s) with orphan connections`);
  }

  return cleanedCount;
}

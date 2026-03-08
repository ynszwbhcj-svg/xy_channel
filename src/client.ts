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

// Monitor for XY channel WebSocket connections
// Follows feishu/monitor.account.ts and feishu/monitor.transport.ts pattern
import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { resolveXYConfig } from "./config.js";
import { getXYWebSocketManager, diagnoseAllManagers, cleanupOrphanConnections } from "./client.js";
import { handleXYMessage } from "./bot.js";

export type MonitorXYOpts = {
  config?: any;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
};

/**
 * Per-session serial queue that ensures messages from the same session are processed
 * in arrival order while allowing different sessions to run concurrently.
 * Following feishu/monitor.account.ts pattern.
 */
function createSessionQueue() {
  const queues = new Map<string, Promise<void>>();
  return (sessionId: string, task: () => Promise<void>): Promise<void> => {
    const prev = queues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(task, task);
    queues.set(sessionId, next);
    void next.finally(() => {
      if (queues.get(sessionId) === next) {
        queues.delete(sessionId);
      }
    });
    return next;
  };
}

/**
 * Monitor XY channel WebSocket connections.
 * Keeps the connection alive until abortSignal is triggered.
 */
export async function monitorXYProvider(opts: MonitorXYOpts = {}): Promise<void> {
  const cfg = opts.config;
  if (!cfg) {
    throw new Error("Config is required for XY monitor");
  }

  const runtime = opts.runtime;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const account = resolveXYConfig(cfg);
  if (!account.enabled) {
    throw new Error(`XY account is disabled`);
  }

  const accountId = opts.accountId ?? "default";

  // 🔍 Diagnose WebSocket managers before gateway start
  console.log("🔍 [DIAGNOSTICS] Checking WebSocket managers before gateway start...");
  diagnoseAllManagers();

  // Get WebSocket manager (cached)
  const wsManager = getXYWebSocketManager(account);

  // Track logged servers to avoid duplicate logs
  const loggedServers = new Set<string>();

  // Track active message processing to detect duplicates
  const activeMessages = new Set<string>();

  // Create session queue for ordered message processing
  const enqueue = createSessionQueue();

  // Health check interval
  let healthCheckInterval: NodeJS.Timeout | null = null;

  return new Promise<void>((resolve, reject) => {
    // Event handlers (defined early so they can be referenced in cleanup)
    const messageHandler = (message: any, sessionId: string, serverId: string) => {
      const messageKey = `${sessionId}::${message.id}`;

      log(`[MONITOR-HANDLER] ####### messageHandler triggered: serverId=${serverId}, sessionId=${sessionId}, messageId=${message.id} #######`);

      // Check for duplicate message handling
      if (activeMessages.has(messageKey)) {
        error(`[MONITOR-HANDLER] ⚠️ WARNING: Duplicate message detected! messageKey=${messageKey}, this may cause duplicate dispatchers!`);
      }

      activeMessages.add(messageKey);
      log(`[MONITOR-HANDLER] 📝 Active messages count: ${activeMessages.size}, messageKey: ${messageKey}`);

      const task = async () => {
        try {
          log(`[MONITOR-HANDLER] 🚀 Starting handleXYMessage for messageKey=${messageKey}`);
          await handleXYMessage({
            cfg,
            runtime,
            message,
            accountId,  // ✅ Pass accountId ("default")
          });
          log(`[MONITOR-HANDLER] ✅ Completed handleXYMessage for messageKey=${messageKey}`);
        } catch (err) {
          // ✅ Only log error, don't re-throw to prevent gateway restart
          error(`XY gateway: error handling message from ${serverId}: ${String(err)}`);
        } finally {
          // Remove from active messages when done
          activeMessages.delete(messageKey);
          log(`[MONITOR-HANDLER] 🧹 Cleaned up messageKey=${messageKey}, remaining active: ${activeMessages.size}`);
        }
      };
      void enqueue(sessionId, task).catch((err) => {
        // Error already logged in task, this is for queue failures
        error(`XY gateway: queue processing failed for session ${sessionId}: ${String(err)}`);
        activeMessages.delete(messageKey);
      });
    };

    const connectedHandler = (serverId: string) => {
      if (!loggedServers.has(serverId)) {
        log(`XY gateway: ${serverId} connected`);
        loggedServers.add(serverId);
      }
    };

    const disconnectedHandler = (serverId: string) => {
      console.warn(`XY gateway: ${serverId} disconnected`);
      loggedServers.delete(serverId);
    };

    const errorHandler = (err: Error, serverId: string) => {
      error(`XY gateway: ${serverId} error: ${String(err)}`);
    };

    const cleanup = () => {
      log("XY gateway: cleaning up...");

      // 🔍 Diagnose before cleanup
      console.log("🔍 [DIAGNOSTICS] Checking WebSocket managers before cleanup...");
      diagnoseAllManagers();

      // Stop health check interval
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
        console.log("⏸️  Stopped periodic health check");
      }

      // Remove event handlers to prevent duplicate calls on gateway restart
      wsManager.off("message", messageHandler);
      wsManager.off("connected", connectedHandler);
      wsManager.off("disconnected", disconnectedHandler);
      wsManager.off("error", errorHandler);

      // ✅ Disconnect the wsManager to prevent connection leaks
      // This is safe because each gateway lifecycle should have clean connections
      wsManager.disconnect();

      loggedServers.clear();
      activeMessages.clear();
      log(`[MONITOR-HANDLER] 🧹 Cleanup complete, cleared active messages`);

      // 🔍 Diagnose after cleanup
      console.log("🔍 [DIAGNOSTICS] Checking WebSocket managers after cleanup...");
      diagnoseAllManagers();
    };

    const handleAbort = () => {
      log("XY gateway: abort signal received, stopping");
      cleanup();
      log("XY gateway stopped");
      resolve();
    };

    if (opts.abortSignal?.aborted) {
      cleanup();
      resolve();
      return;
    }

    opts.abortSignal?.addEventListener("abort", handleAbort, { once: true });

    // Register event handlers (handlers are defined above in cleanup scope)
    wsManager.on("message", messageHandler);
    wsManager.on("connected", connectedHandler);
    wsManager.on("disconnected", disconnectedHandler);
    wsManager.on("error", errorHandler);

    // Start periodic health check (every 5 minutes)
    console.log("🏥 Starting periodic health check (every 5 minutes)...");
    healthCheckInterval = setInterval(() => {
      console.log("🏥 [HEALTH CHECK] Periodic WebSocket diagnostics...");
      diagnoseAllManagers();

      // Auto-cleanup orphan connections
      const cleaned = cleanupOrphanConnections();
      if (cleaned > 0) {
        console.log(`🧹 [HEALTH CHECK] Auto-cleaned ${cleaned} manager(s) with orphan connections`);
      }
    }, 5 * 60 * 1000); // 5 minutes

    // Connect to WebSocket servers
    wsManager.connect()
      .then(() => {
        log("XY gateway: started successfully");
      })
      .catch((err) => {
        // Connection failed but don't reject - continue monitoring for reconnection
        error(`XY gateway: initial connection failed: ${String(err)}`);
        // Still resolve successfully so plugin starts
        resolve();
      });
  });
}

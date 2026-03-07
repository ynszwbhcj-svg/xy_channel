// Monitor for XY channel WebSocket connections
// Follows feishu/monitor.account.ts and feishu/monitor.transport.ts pattern
import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { resolveXYConfig } from "./config.js";
import { getXYWebSocketManager } from "./client.js";
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

  // Get WebSocket manager (cached)
  const wsManager = getXYWebSocketManager(account);

  // Track logged servers to avoid duplicate logs
  const loggedServers = new Set<string>();

  // Create session queue for ordered message processing
  const enqueue = createSessionQueue();

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      log("XY gateway: cleaning up...");
      wsManager.disconnect();
      loggedServers.clear();
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

    // Setup event handlers
    const messageHandler = (message: any, sessionId: string, serverId: string) => {
      const task = async () => {
        try {
          await handleXYMessage({
            cfg,
            runtime,
            message,
            accountId,  // ✅ Pass accountId ("default")
          });
        } catch (err) {
          error(`XY gateway: error handling message from ${serverId}: ${String(err)}`);
          throw err;
        }
      };
      void enqueue(sessionId, task).catch((err) => {
        // Error already logged in task, this is for queue failures
        error(`XY gateway: queue processing failed for session ${sessionId}: ${String(err)}`);
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

    // Register event handlers
    wsManager.on("message", messageHandler);
    wsManager.on("connected", connectedHandler);
    wsManager.on("disconnected", disconnectedHandler);
    wsManager.on("error", errorHandler);

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

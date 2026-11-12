// Monitor for XY channel WebSocket connections
// Follows feishu/monitor.account.ts and feishu/monitor.transport.ts pattern
import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { resolveXYConfig } from "../config.js";
import { getXYWebSocketManager, diagnoseAllManagers, cleanupOrphanConnections, removeXYWebSocketManager } from "../transport/client.js";
import { handleXYMessage } from "./bot.js";
import { extractFileParts, extractModelInput, extractModelName, parseA2AMessage } from "../parser.js";
import { inheritSelectedModelName, isImageAttachment, modelSelectionChanged, type ModelSelection } from "../model-input.js";
import { createInboundAdmissionQueue } from "./inbound-admission.js";
import { hasActiveTask, listActiveTaskBindings } from "../conversation/conversation-manager.js";
import { sendA2AResponse } from "../formatter.js";
import { handleTriggerEvent } from "../trigger-handler.js";
import { handleSelfEvolutionEvent, handleSelfEvolutionStateGetEvent } from "../self-evolution-handler.js";
import { handleLoginTokenEvent } from "../login-token-handler.js";
import { handleCronQueryEvent } from "../cron-query-handler.js";
import { handleMemoryQueryEvent } from "../memory-query-handler.js";
import { handleUpdateTaskConvIdEvent } from "../update-task-conv-id-handler.js";
import { cleanupStaleTempFiles } from "./reply-dispatcher.js";
import { logger } from "../utils/logger.js";

export type MonitorXYOpts = {
  config?: any;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
  setStatus?: (status: { lastEventAt?: number; lastInboundAt?: number; connected?: boolean }) => void;
};

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

  const account = resolveXYConfig(cfg);
  if (!account.enabled) {
    throw new Error(`XY account is disabled`);
  }

  const accountId = opts.accountId ?? "default";

  // Create trackEvent function to report health to OpenClaw framework
  const trackEvent = opts.setStatus
    ? () => {
        opts.setStatus!({ lastEventAt: Date.now(), lastInboundAt: Date.now() });
      }
    : undefined;

  // 🔍 Diagnose WebSocket managers before gateway start
  logger.log("[DIAGNOSTICS] Checking WebSocket managers before gateway start...");
  diagnoseAllManagers();

  // Get WebSocket manager (cached)
  const wsManager = getXYWebSocketManager(account, runtime);

  // ✅ Set health event callback for heartbeat reporting
  if (trackEvent) {
    wsManager.setHealthEventCallback(trackEvent);
  }

  // Track logged servers to avoid duplicate logs
  const loggedServers = new Set<string>();

  // Track active message processing to detect duplicates
  const activeMessages = new Set<string>();
  // 每个 session 已开始的处理 Promise；仅 steer 回退时等待旧 dispatch 收尾。
  const activeTurnTasks = new Map<string, Set<Promise<void>>>();

  // Create session queue for ordered message processing
  const admission = createInboundAdmissionQueue();
  const activeSelections = new Map<string, ModelSelection>();

  // Global gate that serializes dispatch initialization across sessions.
  // When a new session starts dispatching, it acquires this gate and holds it
  // until agent setup (agentTools + wrapStreamFn) is complete, then releases it.
  // This prevents lastRegisteredKey races when multiple sessions initialize
  // concurrently.
  let globalDispatchInitGate: Promise<void> = Promise.resolve();
  const acquireDispatchInitGate = async (): Promise<() => void> => {
    const previous = globalDispatchInitGate;
    let release!: () => void;
    globalDispatchInitGate = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return release;
  };

  // Health check interval
  let healthCheckInterval: NodeJS.Timeout | null = null;
  let stopped = false;

  return new Promise<void>((resolve, reject) => {
    // Event handlers (defined early so they can be referenced in cleanup)
    const messageHandler = (message: any, webSocketSessionId: string, serverId: string) => {
      // A wrapped transport session can carry multiple A2A conversations.
      // Admission and capabilities belong to the conversation, not the socket.
      const sessionId = typeof message.params?.sessionId === "string" && message.params.sessionId
        ? message.params.sessionId
        : typeof message.sessionId === "string" && message.sessionId
          ? message.sessionId
          : webSocketSessionId;
      const messageKey = `${sessionId}::${message.id}`;

      logger.log(`[MONITOR-HANDLER] messageHandler triggered: messageId=${message.id}`);

      // ✅ Report health: received a message
      trackEvent?.();

      // Check for duplicate message handling
      if (activeMessages.has(messageKey)) {
        logger.error(`[MONITOR-HANDLER] WARNING: Duplicate message detected, messageKey=${messageKey}`);
      }

      activeMessages.add(messageKey);
      const previousTurnTasks = Array.from(activeTurnTasks.get(sessionId) ?? []);
      let forceNewTurn = false;
      let selection: ModelSelection | undefined;

      const task = async () => {
        try {
          if (stopped || opts.abortSignal?.aborted) return;
          await handleXYMessage({
            cfg,
            runtime,
            message,
            accountId,  // ✅ Pass accountId ("default")
            webSocketSessionId,
            acquireDispatchInitGate,
            forceNewTurn,
            onTurnAdmitted: () => {
              if (selection) {
                activeSelections.set(sessionId, inheritSelectedModelName(activeSelections.get(sessionId), selection));
              }
            },
            waitForPreviousTurn: async () => {
              await Promise.allSettled(previousTurnTasks);
            },
          });
        } catch (err) {
          // ✅ Only log error, don't re-throw to prevent gateway restart
          logger.error(`XY gateway: error handling message from ${serverId}: ${String(err)}`);
        } finally {
          activeMessages.delete(messageKey);
          if (!hasActiveTask(sessionId)) activeSelections.delete(sessionId);
        }
      };

      const runTask = (): Promise<void> => {
        const pending = task();
        let tasksForSession = activeTurnTasks.get(sessionId);
        if (!tasksForSession) {
          tasksForSession = new Set();
          activeTurnTasks.set(sessionId, tasksForSession);
        }
        tasksForSession.add(pending);
        void pending.finally(() => {
          tasksForSession.delete(pending);
          if (tasksForSession.size === 0) {
            activeTurnTasks.delete(sessionId);
          }
        }).catch(() => {});
        return pending;
      };

      // Steer detection: when queue mode is "steer" and the session has an active
      // run, process the message concurrently (skip the per-session serial queue).
      // This prevents the steer message from waiting behind the first message's
      // completion. Direct injection is handled by bot.ts / steer-service.ts;
      // if the active run rejects the message, bot waits for these tracked tasks
      // to settle before starting a replacement dispatch.
      const messageMethod = message.method;
      if (messageMethod === "clearContext" || messageMethod === "clear_context") {
        void admission.enqueue(sessionId, async () => {
          await runTask();
          activeSelections.delete(sessionId);
        }, true).catch((err) => {
          logger.error(`XY gateway: queue processing failed: ${String(err)}`);
          activeMessages.delete(messageKey);
        });
      } else if (messageMethod === "tasks/cancel" || messageMethod === "tasks_cancel") {
        // tasks/cancel 仅发送一个简单的响应，不涉及复杂的任务状态变更，
        // 因此无需排队等待，直接并发执行以确保客户端及时收到 canceled 响应。
        logger.log(`[MONITOR] CANCEL: executing concurrently, messageKey=${messageKey}`);
        void runTask().catch((err) => {
          logger.error(`XY gateway: concurrent cancel task failed for ${messageKey}: ${String(err)}`);
          activeMessages.delete(messageKey);
        });
      } else {
        try {
          const parsed = parseA2AMessage(message);
          selection = {
            modelName: extractModelName(parsed.parts),
            modelCapabilities: extractModelInput(parsed.parts),
          };
          const steerMode = cfg.messages?.queue?.mode === "steer";
          const hasActiveRun = hasActiveTask(parsed.sessionId);
          const nativeImages = selection.modelCapabilities.supportsNativeImages &&
            extractFileParts(parsed.parts).some(isImageAttachment);
          const changedSelection = hasActiveRun && modelSelectionChanged(activeSelections.get(sessionId), selection);
          forceNewTurn = (hasActiveRun && nativeImages) || changedSelection || admission.hasBarrier(sessionId);

          if (steerMode && hasActiveRun && !forceNewTurn) {
            logger.log(`[MONITOR] STEER MODE: executing concurrently, sessionId=${parsed.sessionId}, messageKey=${messageKey}`);
            void runTask().catch((err) => {
              logger.error(`XY gateway: concurrent steer task failed for ${messageKey}: ${String(err)}`);
              activeMessages.delete(messageKey);
            });
          } else {
            // Mark a boundary synchronously, before async downloads/dispatch.
            // Later text messages must not jump ahead into the previous run.
            const barrier = forceNewTurn || admission.hasQueued(sessionId);
            forceNewTurn = barrier;
            void admission.enqueue(sessionId, runTask, barrier).catch((err) => {
              logger.error(`XY gateway: queue processing failed: ${String(err)}`);
              activeMessages.delete(messageKey);
            });
          }
        } catch {
          void admission.enqueue(sessionId, runTask, true).catch((err) => {
            logger.error(`XY gateway: queue processing failed: ${String(err)}`);
            activeMessages.delete(messageKey);
          });
        }
      }
    };

    const connectedHandler = (serverId: string) => {
      if (!loggedServers.has(serverId)) {
        logger.log(`XY gateway: ${serverId} connected`);
        loggedServers.add(serverId);
      }
      // ✅ Report health: connection established
      trackEvent?.();
      opts.setStatus?.({ connected: true });
    };

    const disconnectedHandler = (serverId: string) => {
      logger.log(`XY gateway: ${serverId} disconnected`);
      loggedServers.delete(serverId);
      // ✅ Report disconnection status (only if all servers disconnected)
      if (loggedServers.size === 0) {
        opts.setStatus?.({ connected: false });
      }
    };

    const errorHandler = (err: Error, serverId: string) => {
      logger.error(`XY gateway: ${serverId} error: ${String(err)}`);
    };

    const triggerEventHandler = (context: any) => {
      logger.log(`[MONITOR] Received trigger-event, dispatching to handler...`);
      // 异步处理 Trigger 事件，不阻塞主流程
      handleTriggerEvent(context, cfg, runtime, accountId).catch((err) => {
        logger.error(`[MONITOR] Failed to handle trigger-event:`, err);
      });
    };

    const selfEvolutionHandler = (context: any) => {
      logger.log(`[MONITOR] Received self-evolution-event, dispatching to handler...`);
      handleSelfEvolutionEvent(context, cfg).catch((err) => {
        logger.error(`[MONITOR] Failed to handle self-evolution-event:`, err);
      });
    };

    const selfEvolutionStateGetHandler = (context: any) => {
      logger.log(`[MONITOR] Received self-evolution-state-get-event, dispatching to handler...`);
      handleSelfEvolutionStateGetEvent(context, account, runtime, wsManager).catch((err) => {
        logger.error(`[MONITOR] Failed to handle self-evolution-state-get-event:`, err);
      });
    };

    const loginTokenEventHandler = (context: any) => {
      logger.log(`[MONITOR] Received login-token-event, dispatching to handler...`);
      handleLoginTokenEvent(context, runtime);
    };

    const cronQueryEventHandler = (context: any) => {
      logger.log(`[MONITOR] Received cron-query-event, dispatching to handler...`);
      handleCronQueryEvent(context, cfg).catch((err) => {
        logger.error(`[MONITOR] Failed to handle cron-query-event:`, err);
      });
    };

    const memoryQueryEventHandler = (context: any) => {
      logger.log(`[MONITOR] Received memory-query-event, dispatching to handler...`);
      handleMemoryQueryEvent(context, cfg).catch((err) => {
        logger.error(`[MONITOR] Failed to handle memory-query-event:`, err);
      });
    };

    const updateTaskConvIdEventHandler = (context: any) => {
      logger.log(`[MONITOR] Received update-task-conv-id-event, dispatching to handler...`);
      handleUpdateTaskConvIdEvent(context, cfg).catch((err) => {
        logger.error(`[MONITOR] Failed to handle update-task-conv-id-event:`, err);
      });
    };

    const cleanup = () => {
      stopped = true;
      logger.log("XY gateway: cleaning up...");

      // 🔍 Diagnose before cleanup
      logger.log("[DIAGNOSTICS] Checking WebSocket managers before cleanup...");
      diagnoseAllManagers();

      // Stop health check interval
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
        logger.log("Stopped periodic health check");
      }

      // Remove event handlers to prevent duplicate calls on gateway restart
      wsManager.off("message", messageHandler);
      wsManager.off("connected", connectedHandler);
      wsManager.off("disconnected", disconnectedHandler);
      wsManager.off("error", errorHandler);
      wsManager.off("trigger-event", triggerEventHandler);
      wsManager.off("self-evolution-event", selfEvolutionHandler);
      wsManager.off("self-evolution-state-get-event", selfEvolutionStateGetHandler);
      wsManager.off("login-token-event", loginTokenEventHandler);
      wsManager.off("cron-query-event", cronQueryEventHandler);
      wsManager.off("memory-query-event", memoryQueryEventHandler);
      wsManager.off("update-task-conv-id-event", updateTaskConvIdEventHandler);

      // ✅ Disconnect the wsManager to prevent connection leaks
      // This is safe because each gateway lifecycle should have clean connections
      wsManager.disconnect();

      // ✅ Remove manager from cache to prevent reusing dirty state
      removeXYWebSocketManager(account);

      // Session context is ALS-scoped now — nothing global to clean up.

      loggedServers.clear();
      activeMessages.clear();
      activeTurnTasks.clear();
      activeSelections.clear();
      admission.clear();
      logger.log(`[MONITOR-HANDLER] Cleanup complete, cleared active messages and sessions`);

      // 🔍 Diagnose after cleanup
      logger.log("[DIAGNOSTICS] Checking WebSocket managers after cleanup...");
      diagnoseAllManagers();
    };

    const handleAbort = async () => {
      logger.log("XY gateway: abort signal received, sending notifications before stopping");

      // 📤 Send restart notification to all active sessions before disconnecting
      try {
        const activeBindings = listActiveTaskBindings();
        if (activeBindings.length > 0) {
          const config = resolveXYConfig(cfg);
          const notificationText = "Gateway即将重启，重启期间可能短暂出现\u201c环境异常\u201d提示，请稍候并耐心重试~";

          logger.log(`[MONITOR] Sending restart notifications to ${activeBindings.length} active session(s)`);
          const sendPromises = activeBindings.map(binding =>
            sendA2AResponse({
              config,
              sessionId: binding.sessionId,
              taskId: binding.currentTaskId,
              messageId: binding.currentMessageId,
              text: notificationText,
              append: false,
              final: true,
            }).catch(err => {
              logger.error(`[MONITOR] Failed to send restart notification: ${String(err)}`);
            })
          );

          await Promise.all(sendPromises);
          logger.log(`[MONITOR] Restart notifications sent to ${activeBindings.length} session(s)`);
        } else {
          logger.log(`[MONITOR] No active sessions, skipping restart notifications`);
        }
      } catch (err) {
        logger.error(`[MONITOR] Error sending restart notifications: ${String(err)}`);
      }

      cleanup();
      logger.log("XY gateway stopped");
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
    wsManager.on("trigger-event", triggerEventHandler);
    wsManager.on("self-evolution-event", selfEvolutionHandler);
    wsManager.on("self-evolution-state-get-event", selfEvolutionStateGetHandler);
    wsManager.on("login-token-event", loginTokenEventHandler);
    wsManager.on("cron-query-event", cronQueryEventHandler);
    wsManager.on("memory-query-event", memoryQueryEventHandler);
    wsManager.on("update-task-conv-id-event", updateTaskConvIdEventHandler);

    // Start periodic health check (every 6 hours)
    logger.log("Starting periodic health check (every 6 hours)...");
    healthCheckInterval = setInterval(() => {
      logger.log("[HEALTH CHECK] Periodic WebSocket diagnostics...");
      diagnoseAllManagers();

      // Auto-cleanup orphan connections
      const cleaned = cleanupOrphanConnections();
      if (cleaned > 0) {
        logger.log(`[HEALTH CHECK] Auto-cleaned ${cleaned} manager(s) with orphan connections`);
      }

      // Session context is ALS-scoped — no global session cleanup needed.

      // Cleanup stale temp files (older than 24 hours)
      void cleanupStaleTempFiles();
    }, 6 * 60 * 60 * 1000); // 6 hours

    // Connect to WebSocket servers
    wsManager.connect()
      .then(() => {
        logger.log("XY gateway: started successfully");
      })
      .catch((err) => {
        // Connection failed but don't reject - continue monitoring for reconnection
        logger.error(`XY gateway: initial connection failed: ${String(err)}`);
        // Still resolve successfully so plugin starts
        resolve();
      });
  });
}

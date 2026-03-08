// Reply dispatcher - completely following feishu/reply-dispatcher.ts pattern
import type { ClawdbotConfig, RuntimeEnv, ReplyPayload } from "openclaw/plugin-sdk";
import { createReplyPrefixContext } from "openclaw/plugin-sdk";
import { getXYRuntime } from "./runtime.js";
import { sendA2AResponse, sendStatusUpdate } from "./formatter.js";
import { resolveXYConfig } from "./config.js";
import type { XYChannelConfig } from "./types.js";

export interface CreateXYReplyDispatcherParams {
  cfg: ClawdbotConfig;
  runtime: RuntimeEnv;
  sessionId: string;
  taskId: string;
  messageId: string;
  accountId: string;
}

/**
 * Create a reply dispatcher for XY channel messages.
 * Follows feishu pattern with status updates and streaming support.
 * Runtime is expected to be validated before calling this function.
 */
export function createXYReplyDispatcher(params: CreateXYReplyDispatcherParams): any {
  const { cfg, runtime, sessionId, taskId, messageId, accountId } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  log(`[DISPATCHER-CREATE] ******* Creating dispatcher for session=${sessionId}, taskId=${taskId}, messageId=${messageId} *******`);
  log(`[DISPATCHER-CREATE] Stack trace:`, new Error().stack?.split('\n').slice(1, 4).join('\n'));

  log(`[DISPATCHER-CREATE] ======== Creating reply dispatcher ========`);
  log(`[DISPATCHER-CREATE] sessionId: ${sessionId}, taskId: ${taskId}, messageId: ${messageId}`);
  log(`[DISPATCHER-CREATE] Stack trace:`, new Error().stack?.split('\n').slice(1, 4).join('\n'));

  // Get runtime (already validated in monitor.ts, but get reference for use)
  const core = getXYRuntime();

  // Resolve configuration
  const config: XYChannelConfig = resolveXYConfig(cfg);

  // Create reply prefix context (for model selection, etc.)
  const prefixContext = createReplyPrefixContext({ cfg, agentId: accountId });

  // Status update interval (every 60 seconds)
  let statusUpdateInterval: NodeJS.Timeout | null = null;

  // Track if we've sent any response
  let hasSentResponse = false;
  // Track if we've sent the final empty message
  let finalSent = false;
  // Accumulate all text from deliver calls
  let accumulatedText = "";

  /**
   * Start the status update interval
   * Call this immediately after creating the dispatcher
   */
  const startStatusInterval = () => {
    log(`[STATUS INTERVAL] Starting interval for session ${sessionId}, taskId=${taskId}`);

    statusUpdateInterval = setInterval(() => {
      log(`[STATUS INTERVAL] Triggering status update for session ${sessionId}, taskId=${taskId}`);
      void sendStatusUpdate({
        config,
        sessionId,
        taskId,
        messageId,
        text: "任务正在处理中，请稍后~",
        state: "working",
      }).catch((err) => {
        error(`Failed to send status update:`, err);
      });
    }, 60000); // 60 seconds
  };

  /**
   * Stop the status update interval
   */
  const stopStatusInterval = () => {
    if (statusUpdateInterval) {
      log(`[STATUS INTERVAL] Stopping interval for session ${sessionId}, taskId=${taskId}`);
      clearInterval(statusUpdateInterval);
      statusUpdateInterval = null;
      log(`[STATUS INTERVAL] Stopped interval for session ${sessionId}, taskId=${taskId}`);
    }
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, accountId),

      onReplyStart: () => {
        log(`[REPLY START] Reply started for session ${sessionId}, taskId=${taskId}`);
        // Status update interval is now managed externally
      },

      deliver: async (payload: ReplyPayload, info) => {
        const text = payload.text ?? "";

        // 🔍 Debug logging
        log(`[DELIVER] sessionId=${sessionId}, info.kind=${info?.kind}, text.length=${text.length}, text="${text.slice(0, 200)}"`);
        log(`[DELIVER] payload keys: ${Object.keys(payload).join(", ")}`);
        if (payload.mediaUrls) {
          log(`[DELIVER] mediaUrls: ${payload.mediaUrls.length} files`);
        }

        try {
          // Skip empty messages
          if (!text.trim()) {
            log(`[DELIVER SKIP] Empty text, skipping`);
            return;
          }

          // Accumulate text instead of sending immediately
          accumulatedText += text;
          hasSentResponse = true;
          log(`[DELIVER ACCUMULATE] Accumulated text, current length=${accumulatedText.length}`);
        } catch (deliverError) {
          error(`Failed to deliver message:`, deliverError);
        }
      },

      onError: async (err, info) => {
        runtime.error?.(`xy: ${info.kind} reply failed: ${String(err)}`);

        // Stop status updates
        stopStatusInterval();

        // Send error status if we haven't sent any response yet
        if (!hasSentResponse) {
          try {
            await sendStatusUpdate({
              config,
              sessionId,
              taskId,
              messageId,
              text: "处理失败，请稍后重试",
              state: "failed",
            });
          } catch (statusError) {
            error(`Failed to send error status:`, statusError);
          }
        }
      },

      onIdle: async () => {
        log(`[ON_IDLE] Reply idle for session ${sessionId}, hasSentResponse=${hasSentResponse}, finalSent=${finalSent}`);

        // Send accumulated text with append=false and final=true
        if (hasSentResponse && !finalSent) {
          log(`[ON_IDLE] Sending accumulated text, length=${accumulatedText.length}`);
          try {
            await sendA2AResponse({
              config,
              sessionId,
              taskId,
              messageId,
              text: accumulatedText,
              append: false,
              final: true,
            });
            finalSent = true;
            log(`[ON_IDLE] Sent accumulated text`);
          } catch (err) {
            error(`[ON_IDLE] Failed to send accumulated text:`, err);
          }
        } else {
          log(`[ON_IDLE] Skipping final message: hasSentResponse=${hasSentResponse}, finalSent=${finalSent}`);
        }

        // Stop status updates
        stopStatusInterval();
      },

      onCleanup: () => {
        log(`[ON_CLEANUP] Reply cleanup for session ${sessionId}, hasSentResponse=${hasSentResponse}, finalSent=${finalSent}`);

        // Stop status updates
        stopStatusInterval();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
    },
    markDispatchIdle,
    startStatusInterval,  // Expose this to be called immediately
    stopStatusInterval,   // Expose this for manual control if needed
  };
}

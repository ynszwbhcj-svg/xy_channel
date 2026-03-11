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
    }, 30000); // 30 seconds
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

      // 🔧 Tool execution start callback
      onToolStart: async ({ name, phase }) => {
        log(`[TOOL START] 🔧 Tool execution started/updated: name=${name}, phase=${phase}, session=${sessionId}, taskId=${taskId}`);

        // Send status update when tool starts executing
        if (phase === "start") {
          const toolName = name || "unknown";
          try {
            await sendStatusUpdate({
              config,
              sessionId,
              taskId,
              messageId,
              text: `正在使用工具: ${toolName}...`,
              state: "working",
            });
            log(`[TOOL START] ✅ Sent status update for tool start: ${toolName}`);
          } catch (err) {
            error(`[TOOL START] ❌ Failed to send tool start status:`, err);
          }
        }
      },

      // 🔧 Tool execution result callback
      onToolResult: async (payload: ReplyPayload) => {
        const text = payload.text ?? "";
        const hasMedia = Boolean(payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0);

        log(`[TOOL RESULT] 🔧 Tool execution result received: session=${sessionId}, taskId=${taskId}`);
        log(`[TOOL RESULT]   - text.length=${text.length}`);
        log(`[TOOL RESULT]   - hasMedia=${hasMedia}`);
        log(`[TOOL RESULT]   - isError=${payload.isError}`);
        if (text.length > 0) {
          log(`[TOOL RESULT]   - text preview: "${text.slice(0, 200)}"`);
        }

        try {
          // Send tool result as a status update (non-final)
          if (text.length > 0 || hasMedia) {
            const resultText = text.length > 0 ? text : "工具执行完成";

            await sendStatusUpdate({
              config,
              sessionId,
              taskId,
              messageId,
              text: resultText,
              state: "working",
            });
            log(`[TOOL RESULT] ✅ Sent tool result status update`);
          }

          // Note: Tool results will also be accumulated and sent as part of the final response
          // via the deliver callback's accumulatedText mechanism
        } catch (err) {
          error(`[TOOL RESULT] ❌ Failed to send tool result:`, err);
        }
      },

      // 🧠 Reasoning/thinking process streaming callback
      onReasoningStream: async (payload: ReplyPayload) => {
        const text = payload.text ?? "";

        log(`[REASONING STREAM] 🧠 Reasoning/thinking chunk received: session=${sessionId}, taskId=${taskId}`);
        log(`[REASONING STREAM]   - text.length=${text.length}`);
        if (text.length > 0) {
          log(`[REASONING STREAM]   - text preview: "${text.slice(0, 200)}"`);
        }

        try {
          // Send reasoning chunk as a status update (non-final)
          // This provides real-time feedback to the user during thinking
          if (text.length > 0) {
            await sendStatusUpdate({
              config,
              sessionId,
              taskId,
              messageId,
              text: `思考中: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`,
              state: "working",
            });
            log(`[REASONING STREAM] ✅ Sent reasoning chunk status update`);
          }
        } catch (err) {
          error(`[REASONING STREAM] ❌ Failed to send reasoning chunk:`, err);
        }
      },

      // 🏁 Reasoning/thinking end callback
      onReasoningEnd: async () => {
        log(`[REASONING END] 🏁 Reasoning/thinking block ended: session=${sessionId}, taskId=${taskId}`);

        try {
          await sendStatusUpdate({
            config,
            sessionId,
            taskId,
            messageId,
            text: "思考完成，正在努力工作中...",
            state: "working",
          });
          log(`[REASONING END] ✅ Sent reasoning end status update`);
        } catch (err) {
          error(`[REASONING END] ❌ Failed to send reasoning end status:`, err);
        }
      },

      // 📝 Partial reply streaming callback (real-time preview)
      onPartialReply: async (payload: ReplyPayload) => {
        const text = payload.text ?? "";
        const hasMedia = Boolean(payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0);

        log(`[PARTIAL REPLY] 📝 Partial reply chunk received: session=${sessionId}, taskId=${taskId}`);
        log(`[PARTIAL REPLY]   - text.length=${text.length}`);
        log(`[PARTIAL REPLY]   - hasMedia=${hasMedia}`);
        if (text.length > 0) {
          log(`[PARTIAL REPLY]   - text preview: "${text.slice(0, 200)}"`);
        }

        try {
          // Send partial reply chunk as a status update for real-time preview
          // This provides "typing" effect feedback to the user
          if (text.length > 0) {
            // Truncate to reasonable length for status update (avoid overwhelming the UI)
            const previewText = text.slice(0, 150);
            const isTruncated = text.length > 150;

            await sendStatusUpdate({
              config,
              sessionId,
              taskId,
              messageId,
              text: isTruncated ? `生成中: ${previewText}...` : `生成中: ${previewText}`,
              state: "working",
            });
            log(`[PARTIAL REPLY] ✅ Sent partial reply status update (truncated=${isTruncated})`);
          }
        } catch (err) {
          error(`[PARTIAL REPLY] ❌ Failed to send partial reply:`, err);
        }
      },
    },
    markDispatchIdle,
    startStatusInterval,  // Expose this to be called immediately
    stopStatusInterval,   // Expose this for manual control if needed
  };
}

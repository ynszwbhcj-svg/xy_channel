// Reply dispatcher - completely following feishu/reply-dispatcher.ts pattern
import type { ClawdbotConfig, RuntimeEnv, ReplyPayload } from "openclaw/plugin-sdk";
import { getXYRuntime } from "./runtime.js";
import { sendA2AResponse, sendStatusUpdate, sendReasoningTextUpdate } from "./formatter.js";
import { resolveXYConfig } from "./config.js";
import { getCurrentTaskId, getCurrentMessageId } from "./task-manager.js";
import type { XYChannelConfig } from "./types.js";
import fs from "fs/promises";
import path from "path";
import { logger } from "./utils/logger.js";

export interface CreateXYReplyDispatcherParams {
  cfg: ClawdbotConfig;
  runtime: RuntimeEnv;
  sessionId: string;
  taskId: string;
  messageId: string;
  accountId: string;
  isSteerFollower?: boolean;  // 🔑 新增：标记是否是steer模式的第二条消息
}

const TEMP_FILE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * 清理 /tmp/xy_channel 目录中超过 24 小时的旧文件
 */
export async function cleanupStaleTempFiles(tempDir: string = "/tmp/xy_channel"): Promise<void> {
  try {
    const stats = await fs.stat(tempDir).catch(() => null);
    if (!stats?.isDirectory()) {
      return;
    }

    const files = await fs.readdir(tempDir);
    const now = Date.now();
    let cleanedCount = 0;

    for (const file of files) {
      const filePath = path.join(tempDir, file);
      try {
        const fileStat = await fs.stat(filePath);
        if (now - fileStat.mtimeMs > TEMP_FILE_TTL_MS) {
          await fs.unlink(filePath);
          cleanedCount++;
        }
      } catch (err) {
        // 忽略单个文件处理失败
      }
    }

    if (cleanedCount > 0) {
      logger.log(`[CLEANUP] 🧹 Cleaned ${cleanedCount} stale files (>${TEMP_FILE_TTL_MS / 1000 / 3600}h) from ${tempDir}`);
    }
  } catch (err) {
    logger.error(`[CLEANUP] ❌ Failed to cleanup temp dir:`, err);
  }
}

/**
 * Create a reply dispatcher for XY channel messages.
 * Follows feishu pattern with status updates and streaming support.
 * Runtime is expected to be validated before calling this function.
 */
export function createXYReplyDispatcher(params: CreateXYReplyDispatcherParams): any {
  const { cfg, runtime, sessionId, taskId, messageId, accountId, isSteerFollower } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  log(`[DISPATCHER-CREATE] ******* Creating dispatcher *******`);
  log(`[DISPATCHER-CREATE]   - taskId: ${taskId}`);
  log(`[DISPATCHER-CREATE]   - isSteerFollower: ${isSteerFollower ?? false}`);

  // 初始taskId和messageId（作为fallback）
  const initialTaskId = taskId;
  const initialMessageId = messageId;

  /**
   * 🔑 核心改造：动态获取当前活跃的taskId和messageId
   * 每次需要taskId时，都从TaskManager获取最新值
   */
  const getActiveTaskId = (): string => {
    return getCurrentTaskId(sessionId) ?? initialTaskId;
  };

  const getActiveMessageId = (): string => {
    return getCurrentMessageId(sessionId) ?? initialMessageId;
  };

  const core = getXYRuntime();
  const config: XYChannelConfig = resolveXYConfig(cfg);
  // Simplified prefix context for single-account Xiaoyi channel
  const prefixContext = {
    responsePrefix: undefined,
    responsePrefixContextProvider: undefined,
    onModelSelected: undefined,
  };

  let statusUpdateInterval: NodeJS.Timeout | null = null;
  let hasSentResponse = false;
  let finalSent = false;
  let accumulatedText = "";

  /**
   * Start the status update interval
   */
  const startStatusInterval = () => {
    log(`[STATUS INTERVAL] Starting interval for session ${sessionId}`);

    statusUpdateInterval = setInterval(() => {
      // 🔑 使用动态taskId
      const currentTaskId = getActiveTaskId();
      const currentMessageId = getActiveMessageId();

      log(`[STATUS INTERVAL] Triggering status update`);
      log(`[STATUS INTERVAL]   - sessionId: ${sessionId}`);
      log(`[STATUS INTERVAL]   - currentTaskId: ${currentTaskId}`);

      void sendStatusUpdate({
        config,
        sessionId,
        taskId: currentTaskId,  // 🔑 动态taskId
        messageId: currentMessageId,  // 🔑 动态messageId
        text: "任务正在处理中，请稍候~",
        state: "working",
        runtime,
      }).catch((err) => {
        error(`Failed to send status update:`, err);
      });
    }, 30000); // 30 seconds
  };

  const stopStatusInterval = () => {
    if (statusUpdateInterval) {
      log(`[STATUS INTERVAL] Stopping interval for session ${sessionId}`);
      clearInterval(statusUpdateInterval);
      statusUpdateInterval = null;
    }
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, accountId),

      onReplyStart: () => {
        const currentTaskId = getActiveTaskId();
        log(`[REPLY START] Reply started for session ${sessionId}, taskId=${currentTaskId}, isSteerFollower=${isSteerFollower}`);
      },

      deliver: async (payload: ReplyPayload, info) => {
        const text = payload.text ?? "";
        const currentTaskId = getActiveTaskId();
        const currentMessageId = getActiveMessageId();

        log(`[DELIVER] sessionId=${sessionId}, taskId=${currentTaskId}, info.kind=${info?.kind}, text.length=${text.length}`);

        try {
          if (!text.trim()) {
            log(`[DELIVER SKIP] Empty text, skipping`);
            return;
          }

          accumulatedText += text;
          hasSentResponse = true;
          log(`[DELIVER ACCUMULATE] Accumulated text, current length=${accumulatedText.length}`);

          // 🔑 使用动态taskId发送reasoningText更新
          await sendReasoningTextUpdate({
            config,
            sessionId,
            taskId: currentTaskId,
            messageId: currentMessageId,
            text,
          });
          log(`[DELIVER] ✅ Sent deliver text as reasoningText update`);
        } catch (deliverError) {
          error(`Failed to deliver message:`, deliverError);
        }
      },

      onError: async (err, info) => {
        runtime.error?.(`xy: ${info.kind} reply failed: ${String(err)}`);
        stopStatusInterval();

        // 🔑 steer follower不发送错误状态（让主dispatcher处理）
        if (isSteerFollower) {
          log(`[ON_ERROR] Steer follower - skipping error response`);
          return;
        }

        if (!hasSentResponse) {
          const currentTaskId = getActiveTaskId();
          const currentMessageId = getActiveMessageId();

          try {
            await sendStatusUpdate({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text: "处理失败，请稍后重试",
              state: "failed",
              runtime,
            });
          } catch (statusError) {
            error(`Failed to send error status:`, statusError);
          }
        }
      },

      onIdle: async () => {
        const currentTaskId = getActiveTaskId();
        const currentMessageId = getActiveMessageId();

        log(`[ON_IDLE] Reply idle`);
        log(`[ON_IDLE]   - sessionId: ${sessionId}`);
        log(`[ON_IDLE]   - taskId: ${currentTaskId}`);
        log(`[ON_IDLE]   - isSteerFollower: ${isSteerFollower}`);
        log(`[ON_IDLE]   - hasSentResponse: ${hasSentResponse}`);
        log(`[ON_IDLE]   - finalSent: ${finalSent}`);

        // 🔑 核心改动：steer follower不发送final响应
        if (isSteerFollower) {
          log(`[ON_IDLE] Steer follower - skipping final response`);
          log(`[ON_IDLE]   - Message queued successfully, waiting for primary dispatcher`);
          stopStatusInterval();
          return;  // ← 直接返回，不发送任何东西！
        }

        // 正常模式（或steer的第一条消息）
        if (hasSentResponse && !finalSent) {
          log(`[ON_IDLE] Sending accumulated text, length=${accumulatedText.length}`);
          try {
            // 🔑 使用动态taskId发送完成状态
            await sendStatusUpdate({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text: "任务处理已完成~",
              state: "completed",
              runtime,
            });
            log(`[ON_IDLE] ✅ Sent completion status update`);

            // 🔑 使用动态taskId发送最终响应
            await sendA2AResponse({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text: accumulatedText,
              append: false,
              final: true,
              runtime,
            });
            finalSent = true;
            log(`[ON_IDLE] ✅ Sent final response with taskId=${currentTaskId}`);
          } catch (err) {
            error(`[ON_IDLE] Failed to send final response:`, err);
          }
        } else {
          // 正常失败场景（非steer follower）
          log(`[ON_IDLE] Skipping final message: hasSentResponse=${hasSentResponse}, finalSent=${finalSent}`);
          try {
            await sendStatusUpdate({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text: "任务处理中断了~",
              state: "failed",
              runtime,
            });
            log(`[ON_IDLE] ✅ Sent failure status update`);

            await sendA2AResponse({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text: "任务执行异常，请重试~",
              append: false,
              final: true,
              errorCode: 99921111,
              errorMessage: "任务执行异常，请重试",
              runtime,
            });
            finalSent = true;
            log(`[ON_IDLE] ✅ Sent error response with code: 99921111`);
          } catch (err) {
            error(`[ON_IDLE] Failed to send error response:`, err);
          }
        }

        stopStatusInterval();
      },

      onCleanup: () => {
        const currentTaskId = getActiveTaskId();
        log(`[ON_CLEANUP] Reply cleanup, taskId=${currentTaskId}, isSteerFollower=${isSteerFollower}`);
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,

      onToolStart: async ({ name, phase }) => {
        // 🔑 steer follower不发送tool状态（让主dispatcher处理）
        if (isSteerFollower) {
          return;
        }

        const currentTaskId = getActiveTaskId();
        const currentMessageId = getActiveMessageId();

        log(`[TOOL START] Tool: ${name}, phase: ${phase}, taskId: ${currentTaskId}`);

        if (phase === "start") {
          const toolName = name || "unknown";

          // call_device_tool 由自身 execute() 内部发送具体子工具名的状态更新
          // get_xxx_tool_schema 是给 LLM 查 schema 用的，无需向用户展示
          if (toolName === "call_device_tool" || toolName.endsWith("_tool_schema") || toolName === "huawei_id_tool") {
            log(`[TOOL START] Skipping generic status for ${toolName}`);
            return;
          }

          try {
            await sendStatusUpdate({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text: `正在使用工具: ${toolName}...`,
              state: "working",
              runtime,
            });
            log(`[TOOL START] ✅ Sent status update for tool start: ${toolName}`);
          } catch (err) {
            error(`[TOOL START] ❌ Failed to send tool start status:`, err);
          }
        }
      },

      onToolResult: async (payload: ReplyPayload) => {
        // 🔑 steer follower不发送tool结果（让主dispatcher处理）
        if (isSteerFollower) {
          return;
        }

        const currentTaskId = getActiveTaskId();
        const currentMessageId = getActiveMessageId();
        const text = payload.text ?? "";
        const hasMedia = Boolean(payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0);

        log(`[TOOL RESULT] Tool result, taskId: ${currentTaskId}, text.length: ${text.length}`);

        try {
          if (text.length > 0 || hasMedia) {
            const resultText = text.length > 0 ? text : "工具执行完成";

            await sendStatusUpdate({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text: resultText,
              state: "working",
              runtime,
            });
            log(`[TOOL RESULT] ✅ Sent tool result as status update`);
          }
        } catch (err) {
          error(`[TOOL RESULT] ❌ Failed to send tool result status:`, err);
        }
      },

      onReasoningStream: async (payload: ReplyPayload) => {
        // 🔑 steer follower不发送reasoning stream
        if (isSteerFollower) {
          return;
        }

        const text = payload.text ?? "";
        log(`[REASONING STREAM] Reasoning chunk received, text.length: ${text.length}`);

        // Reasoning stream 目前被注释掉
        // 如果需要可以启用
      },

      onPartialReply: async (payload: ReplyPayload) => {
        // 🔑 steer follower不发送partial reply（让主dispatcher处理）
        if (isSteerFollower) {
          return;
        }

        const currentTaskId = getActiveTaskId();
        const currentMessageId = getActiveMessageId();
        const text = payload.text ?? "";

        try {
          if (text.length > 0) {
            await sendReasoningTextUpdate({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text,
              append: false,
            });
          }
        } catch (err) {
          error(`[PARTIAL REPLY] ❌ Failed to send partial reply:`, err);
        }
      },
    },
    markDispatchIdle,
    startStatusInterval,
    stopStatusInterval,
  };
}

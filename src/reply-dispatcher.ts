// Reply dispatcher - completely following feishu/reply-dispatcher.ts pattern
import type { ClawdbotConfig, RuntimeEnv, ReplyPayload } from "openclaw/plugin-sdk";
import { getXYRuntime } from "./runtime.js";
import { sendA2AResponse, sendStatusUpdate, sendReasoningTextUpdate, sendCommand } from "./formatter.js";
import { resolveXYConfig } from "./config.js";
import { getCurrentTaskId, getCurrentMessageId } from "./task-manager.js";
import type { A2ACommand, RunCrossTaskContext, XYChannelConfig } from "./types.js";
import { getCurrentSessionContext } from "./tools/session-manager.js";
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
  steerState: { steered: boolean };  // Dynamic flag set when dispatchReplyFromConfig steers
}

const TEMP_FILE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RUN_CROSS_TASK_LOG_TAG = "[RunCrossTask]";

function buildDistributionStatusCommand(context: RunCrossTaskContext): A2ACommand {
  return {
    header: {
      namespace: "DistributionInteraction",
      name: "DistributionStatus",
    },
    payload: {
      agentId: context.agentId,
      isDistributed: true,
      networkId: context.networkId,
      distributionType: "softbus",
      distributionExecutePolicy: "backgroundExecution",
    },
  };
}

function buildCrossTaskExecuteResultCommand(code: string, message: string, fileUrls: string[] = []): A2ACommand {
  return {
    header: {
      namespace: "DistributionInteraction",
      name: "CrossTaskExecuteResult",
    },
    payload: {
      code,
      message,
      fileUrls,
    },
  };
}

async function sendRunCrossTaskResult(params: {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  context: RunCrossTaskContext;
  resultCode: string;
  resultMessage: string;
}): Promise<void> {
  const { config, sessionId, taskId, messageId, context, resultCode, resultMessage } = params;
  const fileUrls = Array.isArray(context.fileUrls) ? context.fileUrls : [];
  const statusCommand = buildDistributionStatusCommand(context);
  const resultCommand = buildCrossTaskExecuteResultCommand(resultCode, resultMessage, fileUrls);

  await sendCommand({
    config,
    sessionId,
    taskId,
    messageId,
    commands: [statusCommand, resultCommand],
  });

  logger.log(`${RUN_CROSS_TASK_LOG_TAG} sent cross-task result, sessionId=${sessionId}, taskId=${taskId}, code=${resultCode}, fileUrlCount=${fileUrls.length}, messageLength=${resultMessage.length}`);
}

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
  const { cfg, runtime, sessionId, taskId, messageId, accountId, steerState } = params;

  logger.log(`[DISPATCHER-CREATE] ******* Creating dispatcher *******`);
  logger.log(`[DISPATCHER-CREATE]   - taskId: ${taskId}`);

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
  const initialRunCrossTaskContext = getCurrentSessionContext()?.runCrossTaskContext;

  const getRunCrossTaskContext = (): RunCrossTaskContext | undefined => {
    return getCurrentSessionContext()?.runCrossTaskContext ?? initialRunCrossTaskContext;
  };

  /**
   * Start the status update interval
   */
  const startStatusInterval = () => {
    logger.log(`[STATUS INTERVAL] Starting interval for session ${sessionId}`);

    statusUpdateInterval = setInterval(() => {
      // 🔑 使用动态taskId
      const currentTaskId = getActiveTaskId();
      const currentMessageId = getActiveMessageId();

      logger.log(`[STATUS INTERVAL] Triggering status update`);
      logger.log(`[STATUS INTERVAL]   - sessionId: ${sessionId}`);
      logger.log(`[STATUS INTERVAL]   - currentTaskId: ${currentTaskId}`);

      void sendStatusUpdate({
        config,
        sessionId,
        taskId: currentTaskId,  // 🔑 动态taskId
        messageId: currentMessageId,  // 🔑 动态messageId
        text: "任务正在处理中，请稍候~",
        state: "working",
      }).catch((err) => {
        logger.error(`Failed to send status update:`, err);
      });
    }, 30000); // 30 seconds
  };

  const stopStatusInterval = () => {
    if (statusUpdateInterval) {
      logger.log(`[STATUS INTERVAL] Stopping interval for session ${sessionId}`);
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
        logger.log(`[REPLY START] Reply started for session ${sessionId}, taskId=${currentTaskId}, steered=${steerState.steered}`);
      },

      deliver: async (payload: ReplyPayload, info) => {
        // 🔑 steered dispatch不发送内容（让主dispatcher处理）
        if (steerState.steered) {
          logger.log(`[DELIVER] Steered dispatch - skipping deliver, info.kind=${info?.kind}`);
          return;
        }

        const text = payload.text ?? "";
        const currentTaskId = getActiveTaskId();
        const currentMessageId = getActiveMessageId();

        logger.log(`[DELIVER] sessionId=${sessionId}, taskId=${currentTaskId}, info.kind=${info?.kind}, text.length=${text.length}`);

        try {
          if (!text.trim()) {
            logger.log(`[DELIVER SKIP] Empty text, skipping`);
            return;
          }

          accumulatedText += text;
          hasSentResponse = true;
          logger.log(`[DELIVER ACCUMULATE] Accumulated text, current length=${accumulatedText.length}`);

          // 🔑 使用动态taskId发送reasoningText更新
          await sendReasoningTextUpdate({
            config,
            sessionId,
            taskId: currentTaskId,
            messageId: currentMessageId,
            text,
          });
          logger.log(`[DELIVER] ✅ Sent deliver text as reasoningText update`);
        } catch (deliverError) {
          logger.error(`Failed to deliver message:`, deliverError);
        }
      },

      onError: async (err, info) => {
        runtime.error?.(`xy: ${info.kind} reply failed: ${String(err)}`);
        stopStatusInterval();

        // 🔑 steered dispatcher不发送错误状态（让主dispatcher处理）
        if (steerState.steered) {
          logger.log(`[ON_ERROR] Steered dispatch - skipping error response`);
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
            });
          } catch (statusError) {
            logger.error(`Failed to send error status:`, statusError);
          }
        }
      },

      onIdle: async () => {
        const currentTaskId = getActiveTaskId();
        const currentMessageId = getActiveMessageId();

        logger.log(`[ON_IDLE] Reply idle`);
        logger.log(`[ON_IDLE]   - sessionId: ${sessionId}`);
        logger.log(`[ON_IDLE]   - taskId: ${currentTaskId}`);
        logger.log(`[ON_IDLE]   - steered: ${steerState.steered}`);
        logger.log(`[ON_IDLE]   - hasSentResponse: ${hasSentResponse}`);
        logger.log(`[ON_IDLE]   - finalSent: ${finalSent}`);

        // 🔑 steered dispatch不发送final响应（核心已注入到活跃 Pi run）
        if (steerState.steered) {
          logger.log(`[ON_IDLE] Steered dispatch - skipping final response`);
          stopStatusInterval();
          return;  // ← 直接返回，不发送任何东西！
        }

        // 正常模式（或未被steer的dispatch）
        if (hasSentResponse && !finalSent) {
          logger.log(`[ON_IDLE] Sending accumulated text, length=${accumulatedText.length}`);
          try {
            const runCrossTaskContext = getRunCrossTaskContext();
            if (runCrossTaskContext) {
              await sendRunCrossTaskResult({
                config,
                sessionId,
                taskId: currentTaskId,
                messageId: currentMessageId,
                context: runCrossTaskContext,
                resultCode: "0",
                resultMessage: accumulatedText,
              });
            }

            // 🔑 使用动态taskId发送完成状态
            await sendStatusUpdate({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text: "任务处理已完成~",
              state: "completed",
            });
            logger.log(`[ON_IDLE] ✅ Sent completion status update`);

            // 🔑 使用动态taskId发送最终响应
            await sendA2AResponse({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text: accumulatedText,
              append: false,
              final: true,
            });
            finalSent = true;
            logger.log(`[ON_IDLE] ✅ Sent final response with taskId=${currentTaskId}`);
          } catch (err) {
            logger.error(`[ON_IDLE] Failed to send final response:`, err);
          }
        } else {
          // 正常失败场景（非steered）
          logger.log(`[ON_IDLE] Skipping final message: hasSentResponse=${hasSentResponse}, finalSent=${finalSent}`);
          try {
            const runCrossTaskContext = getRunCrossTaskContext();
            if (runCrossTaskContext) {
              await sendRunCrossTaskResult({
                config,
                sessionId,
                taskId: currentTaskId,
                messageId: currentMessageId,
                context: runCrossTaskContext,
                resultCode: "1",
                resultMessage: "任务执行异常，请重试",
              });
            }

            await sendStatusUpdate({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text: "任务处理中断了~",
              state: "failed",
            });
            logger.log(`[ON_IDLE] ✅ Sent failure status update`);

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
            });
            finalSent = true;
            logger.log(`[ON_IDLE] ✅ Sent error response with code: 99921111`);
          } catch (err) {
            logger.error(`[ON_IDLE] Failed to send error response:`, err);
          }
        }

        stopStatusInterval();
      },

      onCleanup: () => {
        const currentTaskId = getActiveTaskId();
        logger.log(`[ON_CLEANUP] Reply cleanup, taskId=${currentTaskId}, steered=${steerState.steered}`);
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,

      onToolStart: async ({ name, phase }) => {
        // 🔑 steered dispatch不发送tool状态（让主dispatcher处理）
        if (steerState.steered) {
          return;
        }

        const currentTaskId = getActiveTaskId();
        const currentMessageId = getActiveMessageId();

        logger.log(`[TOOL START] Tool: ${name}, phase: ${phase}, taskId: ${currentTaskId}`);

        if (phase === "start") {
          const toolName = name || "unknown";

          // call_device_tool 由自身 execute() 内部发送具体子工具名的状态更新
          // get_xxx_tool_schema 是给 LLM 查 schema 用的，无需向用户展示
          if (toolName === "call_device_tool" || toolName.endsWith("_tool_schema") || toolName === "huawei_id_tool") {
            logger.log(`[TOOL START] Skipping generic status for ${toolName}`);
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
            });
            logger.log(`[TOOL START] ✅ Sent status update for tool start: ${toolName}`);
          } catch (err) {
            logger.error(`[TOOL START] ❌ Failed to send tool start status:`, err);
          }
        }
      },

      onToolResult: async (payload: ReplyPayload) => {
        // 🔑 steered dispatch不发送tool结果（让主dispatcher处理）
        if (steerState.steered) {
          return;
        }

        const currentTaskId = getActiveTaskId();
        const currentMessageId = getActiveMessageId();
        const text = payload.text ?? "";
        const hasMedia = Boolean(payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0);

        logger.log(`[TOOL RESULT] Tool result, taskId: ${currentTaskId}, text.length: ${text.length}`);

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
            });
            logger.log(`[TOOL RESULT] ✅ Sent tool result as status update`);
          }
        } catch (err) {
          logger.error(`[TOOL RESULT] ❌ Failed to send tool result status:`, err);
        }
      },

      onReasoningStream: async (payload: ReplyPayload) => {
        // 🔑 steered dispatch不发送reasoning stream
        if (steerState.steered) {
          return;
        }

        const text = payload.text ?? "";
        logger.log(`[REASONING STREAM] Reasoning chunk received, text.length: ${text.length}`);

        // Reasoning stream 目前被注释掉
        // 如果需要可以启用
      },

      onPartialReply: async (payload: ReplyPayload) => {
        // 🔑 steered dispatch不发送partial reply（让主dispatcher处理）
        if (steerState.steered) {
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
          logger.error(`[PARTIAL REPLY] ❌ Failed to send partial reply:`, err);
        }
      },
    },
    markDispatchIdle,
    startStatusInterval,
    stopStatusInterval,
  };
}

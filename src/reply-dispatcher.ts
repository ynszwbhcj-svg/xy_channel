// Reply dispatcher - completely following feishu/reply-dispatcher.ts pattern
import type { ClawdbotConfig, RuntimeEnv, ReplyPayload } from "openclaw/plugin-sdk";
import { getXYRuntime } from "./runtime.js";
import { sendA2AResponse, sendStatusUpdate, sendReasoningTextUpdate, sendCommand } from "./formatter.js";
import { resolveXYConfig } from "./config.js";
import { getCurrentTaskId, getCurrentMessageId } from "./task-manager.js";
import type { A2ACommand, RunCrossTaskContext, XYChannelConfig } from "./types.js";
import { clearRunCrossTaskSentFiles, getCurrentSessionContext } from "./tools/session-manager.js";
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

function buildCrossTaskExecuteResultCommand(
  code: string,
  message: string,
  sentFiles: NonNullable<RunCrossTaskContext["sentFiles"]> = [],
): A2ACommand {
  return {
    header: {
      namespace: "DistributionInteraction",
      name: "CrossTaskExecuteResult",
    },
    payload: {
      code,
      message,
      sentFiles,
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
  const sentFiles = Array.isArray(context.sentFiles) ? context.sentFiles : [];
  const fileCardCount = sentFiles.length;
  const statusCommand = buildDistributionStatusCommand(context);
  const resultCommand = buildCrossTaskExecuteResultCommand(resultCode, resultMessage, sentFiles);

  try {
    await sendCommand({
      config,
      sessionId,
      taskId,
      messageId,
      commands: [statusCommand, resultCommand],
    });
    logger.log(`${RUN_CROSS_TASK_LOG_TAG} sent cross-task result, sessionId=${sessionId}, taskId=${taskId}, code=${resultCode}, fileCardCount=${fileCardCount}, messageLength=${resultMessage.length}`);
  } finally {
    clearRunCrossTaskSentFiles(context);
    logger.log(`${RUN_CROSS_TASK_LOG_TAG} cleared cross-task sentFiles, sessionId=${sessionId}, taskId=${taskId}, clearedFileCardCount=${fileCardCount}`);
  }
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
      logger.log(`[CLEANUP] Cleaned ${cleanedCount} stale files (>${TEMP_FILE_TTL_MS / 1000 / 3600}h) from ${tempDir}`);
    }
  } catch (err) {
    logger.error(`[CLEANUP] Failed to cleanup temp dir:`, err);
  }
}

/**
 * Create a reply dispatcher for XY channel messages.
 * Follows feishu pattern with status updates and streaming support.
 * Runtime is expected to be validated before calling this function.
 */
export function createXYReplyDispatcher(params: CreateXYReplyDispatcherParams): any {
  const { cfg, runtime, sessionId, taskId, messageId, accountId, steerState } = params;

  // 初始taskId和messageId（作为fallback）
  const initialTaskId = taskId;
  const initialMessageId = messageId;

  const getActiveTaskId = (): string => {
    return getCurrentTaskId(sessionId) ?? initialTaskId;
  };

  const getActiveMessageId = (): string => {
    return getCurrentMessageId(sessionId) ?? initialMessageId;
  };

  // Create a scoped logger that always uses this session's sessionId
  // and dynamically resolves the latest taskId
  const scopedLog = () => logger.withContext(sessionId, getActiveTaskId());

  scopedLog().log(`[DISPATCHER-CREATE] Creating dispatcher`);

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
    scopedLog().log(`[STATUS-INTERVAL] Starting interval`);

    statusUpdateInterval = setInterval(() => {
      // 🔑 使用动态taskId
      const currentTaskId = getActiveTaskId();
      const currentMessageId = getActiveMessageId();

      scopedLog().log(`[STATUS-INTERVAL] Triggering status update, taskId=${currentTaskId}`);

      void sendStatusUpdate({
        config,
        sessionId,
        taskId: currentTaskId,  // 🔑 动态taskId
        messageId: currentMessageId,  // 🔑 动态messageId
        text: "任务正在处理中，请稍候~",
        state: "working",
      }).catch((err) => {
        scopedLog().error(`Failed to send status update:`, err);
      });
    }, 30000); // 30 seconds
  };

  const stopStatusInterval = () => {
    if (statusUpdateInterval) {
      scopedLog().log(`[STATUS-INTERVAL] Stopping interval`);
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
        scopedLog().log(`[REPLY-START] Reply started, taskId=${currentTaskId}, steered=${steerState.steered}`);
      },

      deliver: async (payload: ReplyPayload, info) => {
        // 🔑 steered dispatch不发送内容（让主dispatcher处理）
        if (steerState.steered) {
          scopedLog().log(`[DELIVER] Steered dispatch, skipping, kind=${info?.kind}`);
          return;
        }

        const text = payload.text ?? "";
        const currentTaskId = getActiveTaskId();
        const currentMessageId = getActiveMessageId();

        scopedLog().log(`[DELIVER] kind=${info?.kind}, text.length=${text.length}`);

        try {
          if (!text.trim()) {
            scopedLog().log(`[DELIVER SKIP] Empty text, skipping`);
            return;
          }

          // 🔑 如果 onPartialReply 已经流式发送过文本，deliver 不再重复发送
          if (hasSentResponse) {
            scopedLog().log(`[DELIVER SKIP] Already sent via onPartialReply`);
            return;
          }

          accumulatedText += text;
          hasSentResponse = true;

          // 🔑 使用动态taskId发送A2A响应（流式append）
          await sendA2AResponse({
            config,
            sessionId,
            taskId: currentTaskId,
            messageId: currentMessageId,
            text,
            append: true,
            final: false,
          });
        } catch (deliverError) {
          scopedLog().error(`Failed to deliver message:`, deliverError);
        }
      },

      onError: async (err, info) => {
        runtime.error?.(`xy: ${info.kind} reply failed: ${String(err)}`);
        stopStatusInterval();

        // 🔑 steered dispatcher不发送错误状态（让主dispatcher处理）
        if (steerState.steered) {
          scopedLog().log(`[ON-ERROR] Steered dispatch, skipping error response`);
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
            scopedLog().error(`Failed to send error status:`, statusError);
          }
        }
      },

      onIdle: async () => {
        const currentTaskId = getActiveTaskId();
        const currentMessageId = getActiveMessageId();

        scopedLog().log(`[ON-IDLE] Reply idle, steered=${steerState.steered}, hasSentResponse=${hasSentResponse}, finalSent=${finalSent}`);

        // 🔑 steered dispatch不发送final响应（核心已注入到活跃 Pi run）
        if (steerState.steered) {
          scopedLog().log(`[ON-IDLE] Steered dispatch, skipping final response`);
          stopStatusInterval();
          return;  // ← 直接返回，不发送任何东西！
        }

        // 正常模式（或未被steer的dispatch）
        if (hasSentResponse && !finalSent) {
          scopedLog().log(`[ON-IDLE] Sending accumulated text, length=${accumulatedText.length}`);
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
            scopedLog().log(`[ON-IDLE] Sent completion status update`);

            // 🔑 使用动态taskId发送最终响应（空字符串表示流结束）
            await sendA2AResponse({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text: "",
              append: false,
              final: true,
            });
            finalSent = true;
            scopedLog().log(`[ON-IDLE] Sent final response (empty, stream end)`);
          } catch (err) {
            scopedLog().error(`[ON-IDLE] Failed to send final response:`, err);
          }
        } else {
          // 正常失败场景（非steered）
          scopedLog().log(`[ON-IDLE] Skipping final message: hasSentResponse=${hasSentResponse}, finalSent=${finalSent}`);
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
            scopedLog().log(`[ON-IDLE] Sent failure status update`);

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
            scopedLog().log(`[ON-IDLE] Sent error response, code=99921111`);
          } catch (err) {
            scopedLog().error(`[ON-IDLE] Failed to send error response:`, err);
          }
        }

        stopStatusInterval();
      },

      onCleanup: () => {
        const currentTaskId = getActiveTaskId();
        scopedLog().log(`[ON-CLEANUP] Reply cleanup, steered=${steerState.steered}`);
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      suppressToolErrorWarnings: true,
      onModelSelected: prefixContext.onModelSelected,

      onToolStart: async ({ name, phase }) => {
        // 🔑 steered dispatch不发送tool状态（让主dispatcher处理）
        if (steerState.steered) {
          return;
        }

        const currentTaskId = getActiveTaskId();
        const currentMessageId = getActiveMessageId();

        scopedLog().log(`[TOOL-START] Tool: ${name}, phase: ${phase}`);

        if (phase === "start") {
          const toolName = name || "unknown";

          // call_device_tool 由自身 execute() 内部发送具体子工具名的状态更新
          // get_xxx_tool_schema 是给 LLM 查 schema 用的，无需向用户展示
          if (toolName === "call_device_tool" || toolName.endsWith("_tool_schema") || toolName === "huawei_id_tool") {
            scopedLog().log(`[TOOL-START] Skipping generic status for ${toolName}`);
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
            scopedLog().log(`[TOOL-START] Sent status update for tool start: ${toolName}`);
          } catch (err) {
            scopedLog().error(`[TOOL-START] Failed to send tool start status:`, err);
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

        scopedLog().log(`[TOOL-RESULT] Tool result, text.length: ${text.length}`);

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
            scopedLog().log(`[TOOL-RESULT] Sent tool result as status update`);
          }
        } catch (err) {
          scopedLog().error(`[TOOL-RESULT] Failed to send tool result status:`, err);
        }
      },

      onReasoningStream: async (payload: ReplyPayload) => {
        // 🔑 steered dispatch不发送reasoning stream
        if (steerState.steered) {
          return;
        }

        const currentTaskId = getActiveTaskId();
        const currentMessageId = getActiveMessageId();
        let text = payload.text ?? "";

        // Strip "Reasoning:" prefix that some reasoning models add to their thinking output
        const lines = text.split(/\r?\n/);
        if (lines[0]?.trim() === "Reasoning:") {
          text = lines.slice(1).join("\n").trim();
        }

        try {
          if (text.length > 0) {
            // 🔑 将模型真实的thinking/reasoning内容通过reasoningText转发
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
          scopedLog().error(`[REASONING-STREAM] Failed to send reasoning text:`, err);
        }
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
            accumulatedText += text;
            hasSentResponse = true;

            // 🔑 流式文本通过 A2A text 通道发送（而非 reasoningText）
            await sendA2AResponse({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text,
              append: false,
              final: false,
              log: false,
            });
          }
        } catch (err) {
          scopedLog().error(`[PARTIAL-REPLY] Failed to send partial reply:`, err);
        }
      },
    },
    markDispatchIdle,
    startStatusInterval,
    stopStatusInterval,
  };
}

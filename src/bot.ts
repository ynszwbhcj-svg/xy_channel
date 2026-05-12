// Message dispatch engine - following feishu/bot.ts pattern (simplified)
import type { ClawdbotConfig, RuntimeEnv, ReplyPayload } from "openclaw/plugin-sdk";
import { getXYRuntime } from "./runtime.js";
import { createXYReplyDispatcher } from "./reply-dispatcher.js";
import { parseA2AMessage, extractTextFromParts, extractFileParts, extractPushId, extractDeviceType, extractTriggerData, isClearContextMessage, isTasksCancelMessage } from "./parser.js";
import { downloadFilesFromParts } from "./file-download.js";
import { resolveXYConfig } from "./config.js";
import { sendStatusUpdate, sendClearContextResponse, sendTasksCancelResponse, sendA2AResponse } from "./formatter.js";
import {
  appendSelfEvolutionKeywordNudge,
  shouldNudgeForSelfEvolutionKeyword,
} from "./self-evolution-keyword.js";
import { registerSession, unregisterSession, runWithSessionContext } from "./tools/session-manager.js";
import { configManager } from "./utils/config-manager.js";
import { addPushId } from "./utils/pushid-manager.js";
import { getPushDataById } from "./utils/pushdata-manager.js";
import { selfEvolutionManager } from "./utils/self-evolution-manager.js";
import { saveRuntimeInfo } from "./utils/runtime-manager.js";
import { toolCallNudgeManager } from "./utils/tool-call-nudge-manager.js";
import {
  registerTaskId,
  decrementTaskIdRef,
  hasActiveTask,
} from "./task-manager.js";
import type { A2AJsonRpcRequest } from "./types.js";
import { logger } from "./utils/logger.js";

/**
 * Parameters for handling an XY message.
 */
export interface HandleXYMessageParams {
  cfg: ClawdbotConfig;
  runtime: RuntimeEnv;
  message: A2AJsonRpcRequest;
  accountId: string;
  webSocketSessionId?: string; // 可选：WebSocket 层级的 sessionId，用于保存 .xiaoyiruntime
  /** Called after dispatch init is complete (agentTools/wrapStreamFn done). */
  onInitComplete?: () => void;
}

/**
 * Handle an incoming A2A message.
 * This is the main entry point for message processing.
 * Runtime is expected to be validated before calling this function.
 */
export async function handleXYMessage(params: HandleXYMessageParams): Promise<void> {
  const { cfg, runtime, message, accountId, webSocketSessionId } = params;

  // Get runtime (already validated in monitor.ts, but get reference for use)
  const core = getXYRuntime() as any;

  try {
    // Check for special messages BEFORE parsing (these have different param structures)
    const messageMethod = message.method;


    // Handle clearContext messages (params only has sessionId)
    if (messageMethod === "clearContext" || messageMethod === "clear_context") {
      const sessionId = message.params?.sessionId;
      if (!sessionId) {
        throw new Error("clearContext request missing sessionId in params");
      }
      logger.log(`Clear context request for session ${sessionId}`);
      const config = resolveXYConfig(cfg);
      await sendClearContextResponse({
        config,
        sessionId,
        messageId: message.id,
      });
      return;
    }

    // Handle tasks/cancel messages
    if (messageMethod === "tasks/cancel" || messageMethod === "tasks_cancel") {
      const sessionId = message.params?.sessionId;
      const taskId = message.params?.id || message.id;
      if (!sessionId) {
        throw new Error("tasks/cancel request missing sessionId in params");
      }
      logger.log(`Tasks cancel request for session ${sessionId}, task ${taskId}`);
      const config = resolveXYConfig(cfg);
      await sendTasksCancelResponse({
        config,
        sessionId,
        taskId,
        messageId: message.id,
      });
      return;
    }

    // Parse the A2A message (for regular messages)
    const parsed = parseA2AMessage(message);

    // ========== 检测 Trigger 消息 ==========
    // 如果消息中包含 Trigger 事件数据，直接返回 pushData 内容，不走正常流程
    const triggerData = extractTriggerData(parsed.parts);
    if (triggerData) {
      logger.log(`[BOT] 📌 Detected Trigger message with pushDataId: ${triggerData.pushDataId}`);
      logger.log(`[BOT]   - Session ID: ${parsed.sessionId}`);
      logger.log(`[BOT]   - Task ID: ${parsed.taskId}`);

      try {
        // 读取 pushData
        const pushDataItem = await getPushDataById(triggerData.pushDataId);

        if (!pushDataItem) {
          logger.error(`[BOT] ❌ pushData not found for ID: ${triggerData.pushDataId}`);
          return;
        }

        logger.log(`[BOT] ✅ Found pushData, sending direct response`);
        logger.log(`[BOT]   - pushDataId: ${pushDataItem.pushDataId}`);

        const config = resolveXYConfig(cfg);

        // 直接发送响应（final=true，不走 openclaw 流程）
        await sendA2AResponse({
          config,
          sessionId: parsed.sessionId,
          taskId: parsed.taskId,
          messageId: parsed.messageId,
          text: pushDataItem.dataDetail,
          append: false,
          final: true,
        });

        logger.log(`[BOT] ✅ Trigger response sent successfully, exiting early`);
        return;  // 提前返回，不继续处理
      } catch (err) {
        logger.error(`[BOT] ❌ Failed to handle Trigger message:`, err);
        return;
      }
    }
    // ========================================

    // 🔑 注册taskId（检测是否是已有活跃任务的 session）
    const isUpdate = hasActiveTask(parsed.sessionId);

    if (isUpdate) {
      logger.log(`[BOT] 🔄 STEER MODE - Second message detected (core will handle steer)`);
      logger.log(`[BOT]   - Session: ${parsed.sessionId}`);
      logger.log(`[BOT]   - New taskId: ${parsed.taskId}`);
    }

    registerTaskId(parsed.sessionId, parsed.taskId, parsed.messageId);

    // Extract and update push_id if present
    const pushId = extractPushId(parsed.parts);
    if (pushId) {
      logger.log(`[BOT] 📌 Extracted push_id from user message`);
      configManager.updatePushId(parsed.sessionId, pushId);

      // 持久化 pushId 到本地文件（异步，不阻塞主流程）
      addPushId(pushId).catch((err) => {
        logger.error(`[BOT] Failed to persist pushId:`, err);
      });
    } else {
      logger.log(`[BOT] ℹ️  No push_id found in message, will use config default`);
    }

    // Extract deviceType if present (same level as push_id in systemVariables)
    const deviceType = extractDeviceType(parsed.parts);
    if (deviceType) {
      logger.log(`[BOT] 📱 Extracted deviceType from user message: ${deviceType}`);
    }

    // 保存 runtime 信息到 .xiaoyiruntime 文件（异步，不阻塞主流程）
    saveRuntimeInfo(
      webSocketSessionId || parsed.sessionId, // SESSION_ID (WebSocket 层级，如果没有则 fallback)
      parsed.sessionId, // CONVERSATION_ID (param 里的 sessionId)
      parsed.taskId // TASK_ID (param.id)
    ).catch((err) => {
      logger.error(`[BOT] Failed to save runtime info:`, err);
    });

    // Resolve configuration (needed for status updates)
    const config = resolveXYConfig(cfg);

    // ✅ Resolve agent route (following feishu pattern)
    // accountId is "default" for XY (single account mode)
    // Use sessionId as peer.id to ensure all messages in the same session share context
    let route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "xiaoyi-channel",
      accountId,  // "default"
      peer: {
        kind: "direct" as const,
        id: parsed.sessionId,  // ✅ Use sessionId to share context within the same conversation session
      },
    });

    logger.log(`xy: resolved route accountId=${route.accountId}, sessionKey=${route.sessionKey}`);

    registerSession(route.sessionKey, {
      config,
      sessionId: parsed.sessionId,
      taskId: parsed.taskId,
      messageId: parsed.messageId,
      agentId: route.accountId,
      deviceType,
    });

    // 🔑 发送初始状态更新
    logger.log(`[STATUS] Sending initial status update for session ${parsed.sessionId}`);
    void sendStatusUpdate({
      config,
      sessionId: parsed.sessionId,
      taskId: parsed.taskId,
      messageId: parsed.messageId,
      text: "任务正在处理中，请稍候~",
      state: "working",
    }).catch((err) => {
      logger.error(`Failed to send initial status update:`, err);
    });

    // Extract text and files from parts
    const text = extractTextFromParts(parsed.parts);
    let textForAgent = text || "";
    if (route.sessionKey && textForAgent) {
      try {
        const selfEvolutionEnabled = await selfEvolutionManager.isEnabled();
        if (selfEvolutionEnabled && shouldNudgeForSelfEvolutionKeyword(textForAgent)) {
          const shouldNudge = toolCallNudgeManager.tryMarkKeywordNudge(route.sessionKey);
          logger.log(
            `[SELF_EVOLUTION] Keyword check hit during inbound build: sessionKey=${route.sessionKey}, shouldNudge=${shouldNudge}`,
          );
          if (shouldNudge) {
            const augmented = appendSelfEvolutionKeywordNudge(textForAgent);
            textForAgent = augmented.text;
            if (augmented.appended) {
              logger.log(
                `[SELF_EVOLUTION] Keyword-triggered inline nudge appended: sessionKey=${route.sessionKey}`,
              );
            }
          }
        }
      } catch (selfEvolutionError) {
        logger.error(
          `[SELF_EVOLUTION] Failed to append inline keyword nudge: ${String(selfEvolutionError)}`,
        );
      }
    }
    const fileParts = extractFileParts(parsed.parts);

    // Download files to local disk
    const downloadedFiles = await downloadFilesFromParts(fileParts);
    logger.log("Downloaded files:", JSON.stringify(downloadedFiles, null, 2));
    const mediaPayload = buildXYMediaPayload(downloadedFiles);

    // Resolve envelope format options (following feishu pattern)
    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);

    // Build message body with speaker prefix (following feishu pattern)
    let messageBody = textForAgent;

    // Add speaker prefix for clarity
    const speaker = parsed.sessionId;
    messageBody = `${speaker}: ${messageBody}`;

    // Format agent envelope (following feishu pattern)
    const body = core.channel.reply.formatAgentEnvelope({
      channel: "xiaoyi-channel",
      from: speaker,
      timestamp: new Date(),
      envelope: envelopeOptions,
      body: messageBody,
    });

    // ✅ Finalize inbound context (following feishu pattern)
    // Use route.accountId and route.sessionKey instead of parsed fields
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: textForAgent,
      CommandBody: textForAgent,
      From: parsed.sessionId,
      To: parsed.sessionId,  // ✅ Simplified: use sessionId as target (context is managed by SessionKey)
      SessionKey: route.sessionKey,  // ✅ Use route.sessionKey
      AccountId: route.accountId,  // ✅ Use route.accountId ("default")
      ChatType: "direct" as const,
      GroupSubject: undefined,
      SenderName: parsed.sessionId,
      SenderId: parsed.sessionId,
      Provider: "xiaoyi-channel" as const,
      Surface: "xiaoyi-channel" as const,
      MessageSid: `${parsed.taskId}_${deviceType}`,
      Timestamp: Date.now(),
      WasMentioned: false,
      CommandAuthorized: true,
      OriginatingChannel: "xiaoyi-channel" as const,
      OriginatingTo: parsed.sessionId,  // Original message target
      ReplyToBody: undefined, // A2A protocol doesn't support reply/quote
      ...mediaPayload,
    });

    // 🔑 Dynamic steer state: set to true when dispatchReplyFromConfig
    // returns undefined (meaning the core steered the message into the active Pi run).
    const steerState = { steered: false };

    // 🔑 创建dispatcher
    logger.log(`[BOT-DISPATCHER] 🎯 Creating reply dispatcher`);
    logger.log(`[BOT-DISPATCHER]   - taskId: ${parsed.taskId}`);

    const { dispatcher, replyOptions, markDispatchIdle, startStatusInterval } = createXYReplyDispatcher({
      cfg,
      runtime,
      sessionId: parsed.sessionId,
      taskId: parsed.taskId,
      messageId: parsed.messageId,
      accountId: route.accountId,
      steerState,
    });

    startStatusInterval();

    // Build session context for AsyncLocalStorage
    const sessionContext = {
      config,
      sessionId: parsed.sessionId,
      taskId: parsed.taskId,
      messageId: parsed.messageId,
      agentId: route.accountId,
      deviceType,
    };

    logger.log(`[BOT-DISPATCH] ⏳ withReplyDispatcher starting, sessionKey=${route.sessionKey}`);

    await core.channel.reply.withReplyDispatcher({
      dispatcher,
      onSettled: () => {
        logger.log(`[BOT] 🏁 onSettled called for session: ${route.sessionKey}`);
        logger.log(`[BOT]   - steered: ${steerState.steered}`);

        // 🔑 When steered, skip heavy cleanup — the first message's dispatcher is still running
        if (steerState.steered) {
          logger.log(`[BOT] ✅ Steered dispatch settled (skipping cleanup)`);
          return;
        }

        decrementTaskIdRef(parsed.sessionId);
        unregisterSession(route.sessionKey);
        logger.log(`[BOT] ✅ Cleanup completed`);
      },
      run: () => {
        // 🔐 Use AsyncLocalStorage to provide session context to tools.
        // runWithSessionContext returns after the sync part of dispatch
        // (including agentTools + wrapStreamFn) has executed, so we
        // signal init complete to release the global dispatch gate
        // for the next session.
        const dispatchPromise = runWithSessionContext(sessionContext, async () => {
          logger.log(`[BOT-DISPATCH] ⏳ dispatchReplyFromConfig starting...`);
          logger.log(`[BOT-DISPATCH]   - sessionKey: ${ctxPayload.SessionKey}`);
          logger.log(`[BOT-DISPATCH]   - provider: ${ctxPayload.Provider}`);
          logger.log(`[BOT-DISPATCH]   - surface: ${ctxPayload.Surface}`);
          logger.log(`[BOT-DISPATCH]   - from: ${ctxPayload.From}`);
          logger.log(`[BOT-DISPATCH]   - body length: ${(ctxPayload.Body as string)?.length ?? 0}`);
          try {
            const result = await core.channel.reply.dispatchReplyFromConfig({
              ctx: ctxPayload,
              cfg,
              dispatcher,
              replyOptions,
            });

            // 🔑 Core returned undefined = message was steered into the active Pi run
            if (result === undefined) {
              steerState.steered = true;
              logger.log(`[BOT-DISPATCH] ✅ Message steered into active Pi run`);
            } else {
              logger.log(`[BOT-DISPATCH] ✅ dispatchReplyFromConfig returned`);
              logger.log(`[BOT-DISPATCH]   - result: ${JSON.stringify(result)}`);
            }

            return result;
          } catch (dispatchErr) {
            logger.error(`[BOT-DISPATCH] ❌ dispatchReplyFromConfig threw`);
            logger.error(`[BOT-DISPATCH]   - error name: ${dispatchErr instanceof Error ? dispatchErr.name : "unknown"}`);
            logger.error(`[BOT-DISPATCH]   - error message: ${String(dispatchErr)}`);
            logger.error(`[BOT-DISPATCH]   - error stack: ${dispatchErr instanceof Error ? dispatchErr.stack?.slice(0, 500) : "N/A"}`);
            throw dispatchErr;
          }
        });

        // Signal init complete — sync part (agentTools, wrapStreamFn) is done
        params.onInitComplete?.();

        return dispatchPromise;
      },
    });

    logger.log(`[BOT] ✅ Dispatcher completed for session: ${parsed.sessionId}`);
    logger.log(`xy: dispatch complete (session=${parsed.sessionId})`);
  } catch (err) {
    // ✅ Only log error, don't re-throw to prevent gateway restart
    logger.error("Failed to handle XY message:", err);
    runtime.error?.(`xy: Failed to handle message: ${String(err)}`);

    logger.log(`[BOT] ❌ Error occurred, attempting cleanup...`);

    // 🔑 错误时也要清理taskId和session
    try {
      const params = message.params as any;
      const sessionId = params?.sessionId;
      if (sessionId) {
        logger.log(`[BOT] 🧹 Cleaning up after error: ${sessionId}`);

        // 清理 taskId
        decrementTaskIdRef(sessionId);

        // 清理 session
        const core = getXYRuntime() as any;
        const route = core.channel.routing.resolveAgentRoute({
          cfg,
          channel: "xiaoyi-channel",
          accountId,
          peer: {
            kind: "direct" as const,
            id: sessionId,
          },
        });

        unregisterSession(route.sessionKey);
        logger.log(`[BOT] ✅ Cleanup completed after error`);
      }
    } catch (cleanupErr) {
      logger.log(`[BOT] ⚠️  Cleanup failed:`, cleanupErr);
      // Ignore cleanup errors
    }

    // ❌ Don't re-throw: message processing error should not affect gateway stability
  }
}

/**
 * Build media payload for inbound context.
 * Following feishu pattern: buildFeishuMediaPayload().
 *
 * @param mediaList - Downloaded files with local paths
 */
function buildXYMediaPayload(
  mediaList: Array<{ path: string; name: string; mimeType: string }>,
): {
  MediaPath?: string;
  MediaType?: string;
  MediaPaths?: string[];
  MediaTypes?: string[];
} {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((media) => media.path);
  const mediaTypes = mediaList.map((media) => media.mimeType).filter(Boolean);
  return {
    MediaPath: first?.path,
    MediaType: first?.mimeType,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}

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
import { setCsplSteerContext } from "./cspl/steer-context.js";
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
  /**
   * When true, skip taskId/session registration. Used by tryInjectSteer to
   * inject a steer message without overwriting the active taskId or leaking
   * session refCount.
   */
  skipRegistration?: boolean;
}

/**
 * Handle an incoming A2A message.
 * This is the main entry point for message processing.
 * Runtime is expected to be validated before calling this function.
 */
export async function handleXYMessage(params: HandleXYMessageParams): Promise<void> {
  const { cfg, runtime, message, accountId, webSocketSessionId } = params;

  // Cache context for CSPL steer injection (after_tool_call hook)
  setCsplSteerContext(cfg, runtime);

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
    const skipReg = params.skipRegistration === true;

    if (isUpdate) {
      logger.log(`[BOT] 🔄 STEER MODE - Second message detected (core will handle steer)`);
      logger.log(`[BOT]   - Session: ${parsed.sessionId}`);
      logger.log(`[BOT]   - New taskId: ${parsed.taskId}`);
    }

    // Steer injections skip taskId registration to avoid overwriting the active taskId
    if (!skipReg) {
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

      // 保存 runtime 信息到 .xiaoyiruntime 文件（异步，不阻塞主流程）
      saveRuntimeInfo(
        webSocketSessionId || parsed.sessionId, // SESSION_ID (WebSocket 层级，如果没有则 fallback)
        parsed.sessionId, // CONVERSATION_ID (param 里的 sessionId)
        parsed.taskId // TASK_ID (param.id)
      ).catch((err) => {
        logger.error(`[BOT] Failed to save runtime info:`, err);
      });
    }

    // Extract deviceType if present (always parse — used in ctxPayload.MessageSid)
    const deviceType = extractDeviceType(parsed.parts);
    if (deviceType) {
      logger.log(`[BOT] 📱 Extracted deviceType from user message: ${deviceType}`);
    }

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

    // Steer injections skip session registration to avoid refCount leaks
    if (!skipReg) {
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
    }

    // Extract text and files from parts
    const text = extractTextFromParts(parsed.parts);
    let textForAgent = text || "";
    // Self-evolution keyword nudge — only for real user messages, not steer injections
    if (!skipReg && route.sessionKey && textForAgent) {
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
    // 🔑 Steer消息加 /steer 前缀，触发core的 queueEmbeddedPiMessage
    if (isUpdate && textForAgent) {
      textForAgent = `/steer ${textForAgent}`;
      logger.log(`[BOT] 🔄 Prepended /steer for steer injection`);
    }

    // File download — only for real user messages, steer injections have no files
    let mediaPayload: ReturnType<typeof buildXYMediaPayload> = {};
    if (!skipReg) {
      const fileParts = extractFileParts(parsed.parts);
      const downloadedFiles = await downloadFilesFromParts(fileParts);
      logger.log("Downloaded files:", JSON.stringify(downloadedFiles, null, 2));
      mediaPayload = buildXYMediaPayload(downloadedFiles);
    }

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

    // 🔑 Dynamic steer state: when isUpdate (second message), start as steered=true
    // so the dispatcher skips all user-facing callbacks (deliver, onIdle, etc.)
    // and onSettled skips cleanup.
    const steerState = { steered: isUpdate };

    // 🔑 第一条消息创建 streaming 信号（provider.ts 的 wrapStreamFn 触发）
    if (!isUpdate) {
      createStreamingSignal(parsed.sessionId);
    }

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

    // Steer injections don't need status intervals
    if (!skipReg) {
      startStatusInterval();
    }

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

            logger.log(`[BOT-DISPATCH] ✅ dispatchReplyFromConfig returned`);
            logger.log(`[BOT-DISPATCH]   - result: ${JSON.stringify(result)}`);

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

    // 🔑 Steer 串行队列：等待 streaming 信号后 dispatch，多个 steer 按顺序处理
    if (isUpdate) {
      await enqueueSteer({
        sessionId: parsed.sessionId,
        sessionKey: route.sessionKey,
        steerText: textForAgent,
        cfg,
        runtime,
        parsed,
        route,
        deviceType,
      });
    }

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

// ─────────────────────────────────────────────────────────────
// Steer 串行队列 + streaming 信号
// ─────────────────────────────────────────────────────────────

/** Per-session streaming 信号 */
interface StreamingSignal {
  promise: Promise<void>;
  notify: () => void;
}

const streamingSignals = new Map<string, StreamingSignal>();

/**
 * 由 provider.ts 在 wrapStreamFn 调用时触发。
 * 这是模型 API 被调用的精确时刻，此时 isStreaming 一定为 true。
 */
export function notifyModelStreaming(sessionId: string): void {
  const signal = streamingSignals.get(sessionId);
  if (signal) {
    streamingSignals.delete(sessionId);
    signal.notify();
    logger.log(`[STEER-QUEUE] 📡 Model streaming signal fired for session=${sessionId}`);
  }
}

function createStreamingSignal(sessionId: string): StreamingSignal {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  const signal: StreamingSignal = { promise, notify: resolve };
  streamingSignals.set(sessionId, signal);
  logger.log(`[STEER-QUEUE] 🟢 Streaming signal created for session ${sessionId}`);
  return signal;
}

/** Per-session 串行队列：保证同一 session 的 steer 消息按顺序处理 */
const steerQueues = new Map<string, Promise<void>>();

interface EnqueueSteerParams {
  sessionId: string;
  sessionKey: string;
  steerText: string;
  cfg: ClawdbotConfig;
  runtime: RuntimeEnv;
  parsed: ReturnType<typeof parseA2AMessage>;
  route: { accountId: string; sessionKey: string };
  deviceType: string;
}

/**
 * 将 steer 消息放入 per-session 串行队列。
 * 等待第一条消息的 streaming 信号（deliver 首次触发），然后 dispatch。
 * 多个 steer 按到达顺序串行处理，无需重试。
 */
function enqueueSteer(params: EnqueueSteerParams): Promise<void> {
  const { sessionId } = params;

  // 取出当前队列尾部（或 undefined），然后链上新的 Promise
  const prev = steerQueues.get(sessionId);
  const next = (prev ?? Promise.resolve()).then(() => dispatchSteerWhenReady(params));
  steerQueues.set(sessionId, next);

  // 链条结束后清理
  next.catch(() => {}).finally(() => {
    if (steerQueues.get(sessionId) === next) {
      steerQueues.delete(sessionId);
    }
  });

  return next;
}

async function dispatchSteerWhenReady(params: EnqueueSteerParams): Promise<void> {
  const { sessionId, sessionKey, steerText } = params;

  // 1. 等待第一条消息开始 streaming
  const signal = streamingSignals.get(sessionId);
  if (signal) {
    logger.log(`[STEER-QUEUE] ⏳ Waiting for streaming signal, session=${sessionId}`);
    await signal.promise;
    streamingSignals.delete(sessionId);
    logger.log(`[STEER-QUEUE] ✅ Streaming signal received, session=${sessionId}`);
  }

  // 2. 第一条消息已结束 → 放弃
  if (!hasActiveTask(sessionId)) {
    logger.log(`[STEER-QUEUE] ℹ️ First message completed, skip steer`);
    return;
  }

  // 3. 构建 dispatch 上下文并 dispatch /steer
  const core = getXYRuntime() as any;
  const speaker = sessionId;
  const messageBody = `${speaker}: ${steerText}`;
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(params.cfg);
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "xiaoyi-channel",
    from: speaker,
    timestamp: new Date(),
    envelope: envelopeOptions,
    body: messageBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: steerText,
    CommandBody: steerText,
    From: sessionId,
    To: sessionId,
    SessionKey: params.route.sessionKey,
    AccountId: params.route.accountId,
    ChatType: "direct" as const,
    GroupSubject: undefined,
    SenderName: sessionId,
    SenderId: sessionId,
    Provider: "xiaoyi-channel" as const,
    Surface: "xiaoyi-channel" as const,
    MessageSid: `${params.parsed.taskId}_${params.deviceType}`,
    Timestamp: Date.now(),
    WasMentioned: false,
    CommandAuthorized: true,
    OriginatingChannel: "xiaoyi-channel" as const,
    OriginatingTo: sessionId,
    ReplyToBody: undefined,
  });

  const steerState = { steered: true };

  const { dispatcher, replyOptions } = createXYReplyDispatcher({
    cfg: params.cfg,
    runtime: params.runtime,
    sessionId,
    taskId: params.parsed.taskId,
    messageId: params.parsed.messageId,
    accountId: params.route.accountId,
    steerState,
  });

  const sessionContext = {
    config: resolveXYConfig(params.cfg),
    sessionId,
    taskId: params.parsed.taskId,
    messageId: params.parsed.messageId,
    agentId: params.route.accountId,
    deviceType: params.deviceType,
  };

  logger.log(`[STEER-QUEUE] 🚀 Dispatching steer for session=${sessionId}`);

  await core.channel.reply.withReplyDispatcher({
    dispatcher,
    onSettled: () => {
      logger.log(`[STEER-QUEUE] 🏁 Steer dispatch settled for session=${sessionId}`);
    },
    run: () => {
      return runWithSessionContext(sessionContext, async () => {
        const result = await core.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg: params.cfg,
          dispatcher,
          replyOptions,
        });
        logger.log(`[STEER-QUEUE] dispatch result: ${JSON.stringify(result)}`);
        return result;
      });
    },
  });

  logger.log(`[STEER-QUEUE] ✅ Steer dispatch completed for session=${sessionId}`);
}

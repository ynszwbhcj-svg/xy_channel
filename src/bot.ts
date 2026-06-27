// Message dispatch engine - following feishu/bot.ts pattern (simplified)
import type { ClawdbotConfig, RuntimeEnv, ReplyPayload } from "openclaw/plugin-sdk";
import { updateSessionStoreEntry, updateSessionStore, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { getXYRuntime } from "./runtime.js";
import { createXYReplyDispatcher } from "./reply-dispatcher.js";
import { parseA2AMessage, extractTextFromParts, extractFileParts, extractPushId, extractDeviceType, extractAppVer, extractSdkApiVersion, extractModelName, extractTriggerData, extractRunCrossTaskContext, isClearContextMessage, isTasksCancelMessage } from "./parser.js";
import { downloadFilesFromParts } from "./file-download.js";
import { resolveXYConfig } from "./config.js";
import { sendStatusUpdate, sendClearContextResponse, sendTasksCancelResponse, sendA2AResponse } from "./formatter.js";
import {
  appendSelfEvolutionKeywordNudge,
  shouldNudgeForSelfEvolutionKeyword,
} from "./self-evolution-keyword.js";
import { runWithSessionContext } from "./tools/session-manager.js";
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
  const distributionSessionId =
    typeof (message as any)?.sessionId === "string" && (message as any).sessionId.length > 0
      ? (message as any).sessionId
      : undefined;

  // Cache context for CSPL steer injection (after_tool_call hook)
  setCsplSteerContext(cfg, runtime);

  // Get runtime (already validated in monitor.ts, but get reference for use)
  const core = getXYRuntime() as any;

  try {
    // Check for special messages BEFORE parsing (these have different param structures)
    const messageMethod = message.method;

    // Handle clearContext messages (sessionId at top level, no params)
    if (messageMethod === "clearContext" || messageMethod === "clear_context") {
      const sessionId = message.sessionId ?? message.params?.sessionId;
      if (!sessionId) {
        throw new Error("clearContext request missing sessionId in params");
      }
      const log = logger.withContext(sessionId, "");
      log.log(`[BOT] Clear context request`);
      const config = resolveXYConfig(cfg);
      await sendClearContextResponse({
        config,
        sessionId,
        messageId: message.id,
      });
      return;
    }

    // Handle tasks/cancel messages (sessionId at top level, no params)
    if (messageMethod === "tasks/cancel" || messageMethod === "tasks_cancel") {
      const sessionId = message.sessionId ?? message.params?.sessionId;
      const taskId = message.params?.id || message.id;
      if (!sessionId) {
        throw new Error("tasks/cancel request missing sessionId in params");
      }
      const log = logger.withContext(sessionId, taskId);
      log.log(`[BOT] Tasks cancel request`);
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

    // Scoped logger for this session — avoids concurrent session log mixing
    const log = logger.withContext(parsed.sessionId, parsed.taskId);

    // ========== 检测 Trigger 消息 ==========
    // 如果消息中包含 Trigger 事件数据，直接返回 pushData 内容，不走正常流程
    const triggerData = extractTriggerData(parsed.parts);
    if (triggerData) {
      log.log(`[BOT] Detected Trigger message, pushDataId=${triggerData.pushDataId}`);

      try {
        // 读取 pushData
        const pushDataItem = await getPushDataById(triggerData.pushDataId);

        if (!pushDataItem) {
          log.error(`[BOT] pushData not found for ID: ${triggerData.pushDataId}`);
          return;
        }

        log.log(`[BOT] Found pushData, sending direct response, pushDataId=${pushDataItem.pushDataId}`);

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

        log.log(`[BOT] Trigger response sent successfully`);
        return;  // 提前返回，不继续处理
      } catch (err) {
        log.error(`[BOT] Failed to handle Trigger message:`, err);
        return;
      }
    }
    // ========================================

    // 🔑 注册taskId（检测是否是已有活跃任务的 session）
    const isUpdate = hasActiveTask(parsed.sessionId);
    const skipReg = params.skipRegistration === true;

    if (isUpdate) {
      log.log(`[BOT] STEER MODE - Second message detected, new taskId=${parsed.taskId}`);
    }

    // Steer injections skip taskId registration to avoid overwriting the active taskId
    if (!skipReg) {
      registerTaskId(parsed.sessionId, parsed.taskId, parsed.messageId);

      // 🔑 steer 场景：同步更新活跃 dispatcher 的 fallback taskId/messageId
      if (isUpdate) {
        const updater = dispatcherUpdaters.get(parsed.sessionId);
        if (updater) {
          updater(parsed.taskId, parsed.messageId);
        }
      }

      // Extract and update push_id if present
      const pushId = extractPushId(parsed.parts);
      if (pushId) {
        log.log(`[BOT] Extracted push_id from user message`);
        configManager.updatePushId(parsed.sessionId, pushId);

        // 持久化 pushId 到本地文件（异步，不阻塞主流程）
        addPushId(pushId).catch((err) => {
          log.error(`[BOT] Failed to persist pushId:`, err);
        });
      } else {
        log.log(`[BOT] No push_id found in message, using config default`);
      }

      // 保存 runtime 信息到 .xiaoyiruntime 文件（异步，不阻塞主流程）
      saveRuntimeInfo(
        webSocketSessionId || parsed.sessionId, // SESSION_ID (WebSocket 层级，如果没有则 fallback)
        parsed.sessionId, // CONVERSATION_ID (param 里的 sessionId)
        parsed.taskId // TASK_ID (param.id)
      ).catch((err) => {
        log.error(`[BOT] Failed to save runtime info:`, err);
      });
    }

    // Extract deviceType if present (always parse — used in ctxPayload.MessageSid)
    const deviceType = extractDeviceType(parsed.parts);
    if (deviceType) {
      log.log(`[BOT] Extracted deviceType: ${deviceType}`);
    }

    // Extract app_ver and sdk_api_version if present
    const appVer = extractAppVer(parsed.parts);
    if (appVer) {
      log.log(`[BOT] Extracted app_ver: ${appVer}`);
    }
    const sdkApiVersion = extractSdkApiVersion(parsed.parts);
    if (sdkApiVersion) {
      log.log(`[BOT] Extracted sdk_api_version: ${sdkApiVersion}`);
    }

    // Extract modelName if present (used by provider.ts to override model.id)
    const modelName = extractModelName(parsed.parts);
    if (modelName) {
      log.log(`[BOT] Extracted modelName: ${modelName}`);
    }
    const runCrossTaskContext = extractRunCrossTaskContext(parsed.parts);

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

    log.log(`[BOT] Resolved route, sessionKey=${route.sessionKey}`);

    // ALS only: no registerSession. The sessionContext built below is handed
    // to runWithSessionContext() inside withReplyDispatcher.run, which is the
    // single wrap point for the whole agent turn.
    if (!skipReg) {
      // 🔑 Sync A2A modelName to OpenClaw session store so that session_status
      // reports the correct model. Without this, session_status returns the
      // configured default model instead of the A2A-specified one.
      if (modelName && modelName.trim() !== "" && modelName.toLowerCase() !== "none") {
        try {
          const storePath = resolveStorePath();
          const result = await updateSessionStoreEntry({
            storePath,
            sessionKey: route.sessionKey,
            update: async () => ({
              providerOverride: "xiaoyiprovider",
              modelOverride: modelName,
              modelOverrideSource: "user",
              model: "",
              modelProvider: "",
              contextTokens: 256_000,
            }),
          });
          if (!result) {
            // Session entry doesn't exist yet (first message, xy_channel
            // bypasses the standard turn kernel). Create a minimal entry
            // with the override via updateSessionStore.
            await updateSessionStore(storePath, (store) => {
              if (!store[route.sessionKey]) {
                store[route.sessionKey] = {
                  // sessionId must pass validateSessionId regex /^[a-z0-9][a-z0-9._-]{0,127}$/i
                  // route.sessionKey like "agent:main:direct:xxx" contains colons which are invalid.
                  // Use parsed.sessionId (raw UUID from A2A) which is always safe.
                  sessionId: parsed.sessionId,
                  updatedAt: Date.now(),
                  providerOverride: "xiaoyiprovider",
                  modelOverride: modelName,
                  modelOverrideSource: "user",
                  contextTokens: 256_000,
                } as any;
              }
            });
            log.log(`[BOT] Created session entry with model override: xiaoyiprovider/${modelName}`);
          } else {
            log.log(`[BOT] Patched session store model override: xiaoyiprovider/${modelName}`);
          }
        } catch (patchErr) {
          log.error(`[BOT] Failed to patch session model override:`, patchErr);
        }
      }

      // 🔑 发送初始状态更新
      log.log(`[BOT] Sending initial status update`);
      void sendStatusUpdate({
        config,
        sessionId: parsed.sessionId,
        taskId: parsed.taskId,
        messageId: parsed.messageId,
        text: "任务正在处理中，请稍候~",
        state: "working",
      }).catch((err) => {
        log.error(`Failed to send initial status update:`, err);
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
          log.log(
            `[SELF_EVOLUTION] Keyword check hit during inbound build: sessionKey=${route.sessionKey}, shouldNudge=${shouldNudge}`,
          );
          if (shouldNudge) {
            const augmented = appendSelfEvolutionKeywordNudge(textForAgent);
            textForAgent = augmented.text;
            if (augmented.appended) {
              log.log(
                `[SELF_EVOLUTION] Keyword-triggered inline nudge appended: sessionKey=${route.sessionKey}`,
              );
            }
          }
        }
      } catch (selfEvolutionError) {
        log.error(
          `[SELF_EVOLUTION] Failed to append inline keyword nudge: ${String(selfEvolutionError)}`,
        );
      }
    }
    // 🔑 Steer消息: 跳过旧路径直接进入 streaming-signal 队列
    // /steer 前缀由 dispatchSteerWhenReady 内部添加
    if (isUpdate) {
      // 立即释放 init gate——steer 不走 withReplyDispatcher 的 run()
      // 回调，onInitComplete 永远不会被触发。如果不释放，后续消息
      // 会被 globalDispatchInitGate 永久阻塞。
      params.onInitComplete?.();

      // Steer 也支持文件 —— 提取并下载，附带到 mediaPayload
      const steerFileParts = extractFileParts(parsed.parts);
      const steerDownloadedFiles = await downloadFilesFromParts(steerFileParts);
      const steerMediaPayload = buildXYMediaPayload(steerDownloadedFiles);
      if (steerFileParts.length > 0) {
        log.log(`[BOT] Steer message with ${steerFileParts.length} file(s), enqueuing to streaming-signal queue`);
      } else {
        log.log(`[BOT] Steer message — enqueuing to streaming-signal queue`);
      }
      await enqueueSteer({
        sessionId: parsed.sessionId,
        sessionKey: route.sessionKey,
        steerText: textForAgent,        // 原始文本，不带 /steer 前缀
        mediaPayload: steerMediaPayload,
        cfg,
        runtime,
        parsed,
        route,
        deviceType,
      });
      log.log(`[BOT] Steer queue completed`);
      return;
    }

    // ── First message (non-steer) path below ──────────────────────

    // 🔑 立即创建 streaming 信号——必须在文件下载等耗时操作之前，
    // 否则 steer 消息的 dispatchSteerWhenReady 会找不到信号而跳过等待。
    createStreamingSignal(parsed.sessionId);

    // File download — only for real user messages, steer injections have no files
    let mediaPayload: ReturnType<typeof buildXYMediaPayload> = {};
    if (!skipReg) {
      const fileParts = extractFileParts(parsed.parts);
      const downloadedFiles = await downloadFilesFromParts(fileParts);
      log.log(`[BOT] Downloaded ${downloadedFiles.length} file(s)`);
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
      MessageSid: `xiaoyi_${parsed.taskId}_${deviceType}`,
      Timestamp: Date.now(),
      WasMentioned: false,
      CommandAuthorized: true,
      OriginatingChannel: "xiaoyi-channel" as const,
      OriginatingTo: parsed.sessionId,  // Original message target
      ReplyToBody: undefined, // A2A protocol doesn't support reply/quote
      ...mediaPayload,
    });

    // 🔑 Streaming 信号已在上方创建（在文件下载之前）
    const steerState = { steered: false };

    // 🔑 创建dispatcher
    log.log(`[BOT-DISPATCHER] Creating reply dispatcher`);

    // Cleanup: 必须在 onIdle 内部执行（参见 reply-dispatcher.ts 中 onIdleComplete 的注释）
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      log.log(`[BOT] Cleanup started`);
      streamingSignals.delete(parsed.sessionId);
      decrementTaskIdRef(parsed.sessionId);
      log.log(`[BOT] Cleanup completed`);
    };

    const { dispatcher, replyOptions, markDispatchIdle, startStatusInterval, updateFallbackTaskId } = createXYReplyDispatcher({
      cfg,
      runtime,
      sessionId: parsed.sessionId,
      taskId: parsed.taskId,
      messageId: parsed.messageId,
      accountId: route.accountId,
      steerState,
      onIdleComplete: cleanup,
    });

    // 🔑 注册 dispatcher 的 fallback taskId 更新函数，供 steer 路径调用
    dispatcherUpdaters.set(parsed.sessionId, updateFallbackTaskId);

    // Steer injections don't need status intervals
    if (!skipReg) {
      startStatusInterval();
    }

    // Build session context for AsyncLocalStorage
    const sessionContext = {
      config,
      sessionId: parsed.sessionId,
      distributionSessionId,
      taskId: parsed.taskId,
      messageId: parsed.messageId,
      agentId: route.accountId,
      deviceType,
      appVer: appVer ?? undefined,
      sdkApiVersion: sdkApiVersion ?? undefined,
      modelName,
      runCrossTaskContext: runCrossTaskContext ?? undefined,
    };

    log.log(`[BOT-DISPATCH] withReplyDispatcher starting, sessionKey=${route.sessionKey}`);

    await core.channel.reply.withReplyDispatcher({
      dispatcher,
      onSettled: () => {
        log.log(`[BOT] onSettled, steered=${steerState.steered}`);

        // 🔑 When steered, skip cleanup — the first message's dispatcher is still running
        if (steerState.steered) {
          log.log(`[BOT] Steered dispatch settled, skipping cleanup`);
          return;
        }

        // cleanup 已由 onIdleComplete 在 onIdle 的 finally 中执行。
        // onSettled 不做任何清理（直接在这里清理会发生 race condition）。
        dispatcherUpdaters.delete(parsed.sessionId);
      },
      run: () => {
        // 🔐 Use AsyncLocalStorage to provide session context to tools.
        // runWithSessionContext returns after the sync part of dispatch
        // (including agentTools + wrapStreamFn) has executed, so we
        // signal init complete to release the global dispatch gate
        // for the next session.
        const dispatchPromise = runWithSessionContext(sessionContext, async () => {
          log.log(`[ALS-PROOF] bot entered dispatch scope sessionId=${(sessionContext as any).sessionId} taskId=${(sessionContext as any).taskId} isSteer=false`);
          log.log(`[BOT-DISPATCH] dispatchReplyFromConfig starting, body.length=${(ctxPayload.Body as string)?.length ?? 0}`);
          try {
            const result = await core.channel.reply.dispatchReplyFromConfig({
              ctx: ctxPayload,
              cfg,
              dispatcher,
              replyOptions,
            });

            log.log(`[BOT-DISPATCH] dispatchReplyFromConfig returned, result=${JSON.stringify(result)}`);

            return result;
          } catch (dispatchErr) {
            log.error(`[BOT-DISPATCH] dispatchReplyFromConfig threw: ${dispatchErr instanceof Error ? `${dispatchErr.name}: ${dispatchErr.message}` : String(dispatchErr)}`, dispatchErr instanceof Error ? dispatchErr.stack?.slice(0, 500) : undefined);
            throw dispatchErr;
          }
        });

        // Signal init complete — sync part (agentTools, wrapStreamFn) is done
        params.onInitComplete?.();

        return dispatchPromise;
      },
    });

    log.log(`[BOT] Dispatcher completed`);
  } catch (err) {
    // ✅ Only log error, don't re-throw to prevent gateway restart
    // Note: if error occurs before parseA2AMessage, `log` may not be defined yet
    const errSessionId = (message.params as any)?.sessionId || "";
    const errTaskId = (message.params as any)?.id || message.id || "";
    const errLog = logger.withContext(errSessionId, errTaskId);

    errLog.error("Failed to handle XY message:", err);
    runtime.error?.(`xy: Failed to handle message: ${String(err)}`);

    errLog.log(`[BOT] Error occurred, attempting cleanup`);

    // 🔑 错误时也要清理taskId（session 走 ALS，作用域退出自动清理）
    try {
      const params = message.params as any;
      const sessionId = params?.sessionId;
      if (sessionId) {
        errLog.log(`[BOT] Cleaning up after error`);

        // 清理 taskId
        decrementTaskIdRef(sessionId);

        errLog.log(`[BOT] Cleanup completed after error`);
      }
    } catch (cleanupErr) {
      errLog.log(`[BOT] Cleanup failed:`, cleanupErr);
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

// Use globalThis to survive module deduplication — provider.ts may load a
// different copy of bot.ts, so a plain module-level Map would be two objects.
const _g = globalThis as Record<string, unknown>;

if (!_g.__xyStreamingSignals) _g.__xyStreamingSignals = new Map<string, StreamingSignal>();
if (!_g.__xySteerQueues) _g.__xySteerQueues = new Map<string, Promise<void>>();
if (!_g.__xyDispatcherUpdaters) _g.__xyDispatcherUpdaters = new Map<string, (taskId: string, messageId: string) => void>();

const streamingSignals = _g.__xyStreamingSignals as Map<string, StreamingSignal>;
const steerQueues = _g.__xySteerQueues as Map<string, Promise<void>>;
const dispatcherUpdaters = _g.__xyDispatcherUpdaters as Map<string, (taskId: string, messageId: string) => void>;

/**
 * 由 provider.ts 在 wrapStreamFn 调用时触发。
 * 这是模型 API 被调用的精确时刻，此时 isStreaming 一定为 true。
 */
export function notifyModelStreaming(sessionId: string): void {
  const log = logger.withContext(sessionId, "");
  const signal = streamingSignals.get(sessionId);
  if (signal) {
    // 不删除 signal——后续 steer 需要靠它判断模型已在 streaming。
    // 清理由第一条消息的 onSettled 兜底。
    signal.notify();
    log.log(`[STEER-QUEUE] Model streaming signal fired`);
  }
}

function createStreamingSignal(sessionId: string): StreamingSignal {
  const log = logger.withContext(sessionId, "");
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  const signal: StreamingSignal = { promise, notify: resolve };
  streamingSignals.set(sessionId, signal);
  log.log(`[STEER-QUEUE] Streaming signal created`);
  return signal;
}

interface EnqueueSteerParams {
  sessionId: string;
  sessionKey: string;
  steerText: string;
  mediaPayload: ReturnType<typeof buildXYMediaPayload>;
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
  const log = logger.withContext(sessionId, params.parsed.taskId);

  // 取出当前队列尾部（或 undefined），然后链上新的 Promise
  const prev = steerQueues.get(sessionId);
  const next = (prev ?? Promise.resolve()).then(() => dispatchSteerWhenReady(params));
  steerQueues.set(sessionId, next);

  // 链条结束后清理
  next.catch((err) => {
    log.error(`[STEER-QUEUE] Steer chain failed: ${String(err)}`);
  }).finally(() => {
    if (steerQueues.get(sessionId) === next) {
      steerQueues.delete(sessionId);
    }
  });

  return next;
}

async function dispatchSteerWhenReady(params: EnqueueSteerParams): Promise<void> {
  const { sessionId, sessionKey, steerText } = params;
  const log = logger.withContext(sessionId, params.parsed.taskId);

  // 1. 等待第一条消息开始 streaming
  //    signal 可能尚未创建（第一条消息还在文件下载等耗时操作中），
  //    轮询等待直到 signal 出现，最長等待 ~5 秒。
  let signal = streamingSignals.get(sessionId);
  if (!signal) {
    log.log(`[STEER-QUEUE] Signal not yet created, polling`);
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      signal = streamingSignals.get(sessionId);
      if (signal) break;
      if (!hasActiveTask(sessionId)) {
        log.log(`[STEER-QUEUE] First message completed while waiting, skip steer`);
        return;
      }
    }
  }
  if (signal) {
    log.log(`[STEER-QUEUE] Waiting for streaming signal`);
    await signal.promise;
    log.log(`[STEER-QUEUE] Streaming signal received`);
  } else {
    // 轮询超时且 hasActiveTask 仍为 true——说明第一条消息可能卡在异常路径，
    // 没有创建 signal。此时 dispatch 会与第一条消息的模型调用并发冲突，放弃。
    log.log(`[STEER-QUEUE] Signal never appeared after polling, skip steer to avoid collision`);
    return;
  }

  // 2. 第一条消息已结束 → 放弃
  if (!hasActiveTask(sessionId)) {
    log.log(`[STEER-QUEUE] First message completed, skip steer`);
    return;
  }

  // 3. 构建 dispatch 上下文并 dispatch /steer
  const core = getXYRuntime() as any;
  const speaker = sessionId;

  // 如果有文件附件，把路径拼到 steer 文本末尾，让模型通过工具读取
  const mediaPaths = params.mediaPayload?.MediaPaths;
  const fileHint =
    mediaPaths && mediaPaths.length > 0
      ? `\n【用户上传附件】：${JSON.stringify(mediaPaths)}`
      : "";
  const steerCommand = `/steer ${steerText}${fileHint}`;
  const messageBody = `${speaker}: ${steerCommand}`;
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
    RawBody: steerCommand,
    CommandBody: steerCommand,
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
    MessageSid: `xiaoyi_${params.parsed.taskId}_${params.deviceType}`,
    Timestamp: Date.now(),
    WasMentioned: false,
    CommandAuthorized: true,
    OriginatingChannel: "xiaoyi-channel" as const,
    OriginatingTo: sessionId,
    ReplyToBody: undefined,
    ...params.mediaPayload,
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

  log.log(`[STEER-QUEUE] Dispatching steer`);

  await core.channel.reply.withReplyDispatcher({
    dispatcher,
    onSettled: () => {
      log.log(`[STEER-QUEUE] Steer dispatch settled`);
    },
    run: () => {
      return runWithSessionContext(sessionContext, async () => {
        log.log(`[ALS-PROOF] bot entered steer dispatch scope sessionId=${(sessionContext as any).sessionId} taskId=${(sessionContext as any).taskId} isSteer=true`);
        const result = await core.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg: params.cfg,
          dispatcher,
          replyOptions,
        });
        log.log(`[STEER-QUEUE] dispatch result: ${JSON.stringify(result)}`);
        return result;
      });
    },
  });

  log.log(`[STEER-QUEUE] Steer dispatch completed`);
}

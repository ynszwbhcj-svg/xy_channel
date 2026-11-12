// Message dispatch engine - following feishu/bot.ts pattern (simplified)
import type { ClawdbotConfig, RuntimeEnv, ReplyPayload } from "openclaw/plugin-sdk";
import { resolveRuntimeConversationBindingRoute } from "openclaw/plugin-sdk/conversation-runtime";
import { updateSessionStoreEntry, updateSessionStore, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import {
  callGatewayTool,
  resolveActiveEmbeddedRunSessionId,
  abortAgentHarnessRun,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { getXYRuntime } from "../runtime.js";
import { createXYReplyDispatcher } from "./reply-dispatcher.js";
import { createLegacyReplyDispatcher } from "../legacy/reply-dispatcher.js";
import { sendStatusUpdate as legacySendStatusUpdate, sendA2AResponse as legacySendA2AResponse } from "../legacy/formatter.js";
import { parseA2AMessage, extractTextFromParts, extractFileParts, extractPushId, extractDeviceType, extractAppVer, extractSdkApiVersion, extractModelName, extractModelInput, extractTriggerData, extractRunCrossTaskContext, isClearContextMessage, isTasksCancelMessage } from "../parser.js";
import { downloadFilesFromParts } from "../file-download.js";
import { isImageAttachment } from "../model-input.js";
import { loadNativeImages, NATIVE_IMAGE_MAX_BYTES, NativeImageInputError } from "../native-images.js";
import { resolveXYConfig } from "../config.js";
import { sendClearContextResponse, sendTasksCancelResponse, sendA2AResponse, sendDisplayTaskCardData, sendStatusUpdate } from "../formatter.js";
import {
  appendSelfEvolutionKeywordNudge,
  shouldNudgeForSelfEvolutionKeyword,
} from "../self-evolution-keyword.js";
import { runWithSessionContext } from "../tools/session-manager.js";
import { configManager } from "../utils/config-manager.js";
import { addPushId } from "../utils/pushid-manager.js";
import { getPushDataById } from "../utils/pushdata-manager.js";
import { selfEvolutionManager } from "../utils/self-evolution-manager.js";
import { saveRuntimeInfo } from "../utils/runtime-manager.js";
import { toolCallNudgeManager } from "../utils/tool-call-nudge-manager.js";
import { tryDirectSteer } from "../conversation/steer-service.js";
import { markAppVersion, isLegacyAppVersion } from "../utils/app-version.js";
import {
  registerTask,
  completeTask,
  hasActiveTask,
  bindSessionKey,
  getSession,
  getWaitState,
  hasWaitState,
  markParentSettled,
  markTurnInflight,
  clearTurnInflight,
  markTurnCanceled,
  isTurnCanceled,
  isTurnSuperseded,
  getCurrentDispatchTaskId,
  cacheXYConfig,
  getCurrentTaskId,
  getCurrentMessageId,
  clearWaitState,
  getOrCreateSession,
} from "../conversation/conversation-manager.js";
import { clearPendingApproval } from "../approval-bridge.js";
import type { A2AJsonRpcRequest, XYChannelConfig } from "../types.js";
import { logger } from "../utils/logger.js";

// ── steer 回退重分发前的 channel 侧就绪判定 ───────────────────────
// 只使用 openclaw 已暴露的 resolveActiveEmbeddedRunSessionId 与 channel 自身
// 的任务链收尾信号，不依赖、不修改上游内部实现。超时只放行、不重试。
const CHANNEL_READY_POLL_MS = 100;
const CHANNEL_READY_TIMEOUT_MS = 3_000;

/**
 * steer 直接注入失败后、重分发前的短保守等待：上游活跃 run 退出或 channel 侧
 * 旧 turn 收尾即放行，从源头消掉「重分发撞上活跃 run → 被排成 followup →
 * 空 idle 误判失败」。长等待已由 waitForPreviousTurn 承担，这里只补边界窗口。
 * 超时放行、不重试；残余竞态由 reply-dispatcher 的空 idle 延后收尾兜底。
 * 仅作用于 steer 回退分支，其余通路一律不受影响。
 */
async function waitForChannelTurnReady(
  sessionId: string,
  sessionKey: string | undefined,
  log: ReturnType<typeof logger.withContext>,
): Promise<void> {
  if (!sessionKey) return;
  const deadline = Date.now() + CHANNEL_READY_TIMEOUT_MS;
  for (;;) {
    const session = getSession(sessionId);
    // 任务链已清空：clearContext 或旧 turn 的 onIdleComplete 已收尾 → 直接放行。
    if (!session || session.tasks.length === 0) return;
    // tasks/cancel 并发 abort、subagent 等待态：各有自己的收口时序，不等待。
    const canceledTurn = session.tasks.some((t) => session.canceledTurnIds.has(t.taskId));
    if (canceledTurn || hasWaitState(sessionId)) return;

    let upstreamActive = false;
    try {
      upstreamActive = !!resolveActiveEmbeddedRunSessionId(sessionKey);
    } catch {
      upstreamActive = false;
    }
    if (!upstreamActive) return;

    if (Date.now() >= deadline) {
      log.warn(`[BOT-STEER] Channel readiness wait timed out — proceeding without retry`);
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, CHANNEL_READY_POLL_MS));
  }
}

const SDK_TURN_IDLE_TIMEOUT_MS = 30_000;

/** A full image/model turn must not enter the SDK's text-only steer branch. */
async function waitForSdkTurnIdle(
  sessionKey: string | undefined,
  log: ReturnType<typeof logger.withContext>,
): Promise<"idle" | "timeout" | "unavailable"> {
  if (!sessionKey) return "unavailable";
  const deadline = Date.now() + SDK_TURN_IDLE_TIMEOUT_MS;
  for (;;) {
    try {
      if (!resolveActiveEmbeddedRunSessionId(sessionKey)) return "idle";
    } catch (err) {
      log.error(`[BOT-DISPATCH] Cannot verify SDK turn readiness:`, err);
      return "unavailable";
    }
    if (Date.now() >= deadline) return "timeout";
    await new Promise<void>((resolve) => setTimeout(resolve, CHANNEL_READY_POLL_MS));
  }
}

/** Close only the rejected incoming task; an older live run keeps its state. */
async function failBeforeDispatch(params: {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  text: string;
  stepName: string;
}): Promise<void> {
  const { config, sessionId, taskId, messageId, text, stepName } = params;
  const outboundQueue = getOrCreateSession(sessionId).outboundQueue;
  const legacy = isLegacyAppVersion(taskId);
  outboundQueue.enqueue({
    taskId,
    label: "inbound-failure-status",
    send: () => (legacy ? legacySendStatusUpdate : sendStatusUpdate)({
      config, sessionId, taskId, messageId, text, state: "failed",
    }),
  });
  if (!legacy) {
    outboundQueue.enqueue({
      taskId,
      label: "inbound-failure-card",
      send: () => sendDisplayTaskCardData({
        config, sessionId, taskId, messageId, index: 1, stepName, isFinal: true,
      }),
    });
  }
  outboundQueue.enqueue({
    taskId,
    label: "inbound-failure-final",
    send: () => (legacy ? legacySendA2AResponse : sendA2AResponse)({
      config, sessionId, taskId, messageId, text, append: false, final: true,
      errorCode: 99921111, errorMessage: text,
    }),
  });
  await outboundQueue.whenIdle();
  completeTask(sessionId, taskId);
}

/**
 * Parameters for handling an XY message.
 */
export interface HandleXYMessageParams {
  cfg: ClawdbotConfig;
  runtime: RuntimeEnv;
  message: A2AJsonRpcRequest;
  accountId: string;
  webSocketSessionId?: string; // 可选：WebSocket 层级的 sessionId，用于保存 .xiaoyiruntime
  /** 在实际 dispatch 初始化前获取全局门，初始化完成后释放。 */
  acquireDispatchInitGate?: () => Promise<() => void>;
  /** steer 回退前等待同 session 的旧 dispatch 收尾，避免并发争用会话写锁。 */
  waitForPreviousTurn?: () => Promise<void>;
  /** Attachments/model changes must enter a complete turn instead of text-only steer. */
  forceNewTurn?: boolean;
  /** Commit the monitor's model snapshot only after this complete turn is admitted. */
  onTurnAdmitted?: () => void;
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

      // 🔑 固定会话特殊处理：pinnedSessionIds（默认 "00000000"）的 A2A sessionId
      // 永不变化，clearContext 无法靠客户端换 sessionId 天然隔离上下文，因此
      // 显式调 gateway sessions.reset 在同一个 sessionKey 下轮换 openclaw 内层
      // sessionId（归档旧 transcript、abort 在途 run），A2A 层 sessionId 不变。
      //
      // 时序保证：先回响应（reset 可能因 abort 在途 run 耗时数秒，不让客户端等），
      // 再 await reset 完成后才返回——monitor 按 sessionId 串行排队，本函数不返回
      // 下一条消息就不会开始处理，确保其读到的是 reset 后的新会话。
      if (config.pinnedSessionIds.includes(sessionId)) {
        await resetPinnedOpenclawSession({ cfg, core, accountId, sessionId });
      }
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

      // 让"停止"真正停止：abort 当前活跃 run，避免在途上一轮完整吐到端侧。
      // 通过 conversation-manager 的 getSession 拿到 openclaw sessionKey，再解析活跃 run。
      const sessionKey = getSession(sessionId)?.sessionKey;
      if (!sessionKey) {
        log.warn(`[TASKS_CANCEL] No sessionKey bound for sessionId, cannot abort active run`);
      } else {
        const activeRun = resolveActiveEmbeddedRunSessionId(sessionKey);
        if (activeRun) {
          const ownerTaskId = getCurrentDispatchTaskId(sessionId) ?? getCurrentTaskId(sessionId) ?? taskId;
          const aborted = abortAgentHarnessRun(activeRun);
          log.log(`[TASKS_CANCEL] aborted active run=${activeRun} result=${aborted}`);
          if (aborted) {
            // tasks/cancel 已有 canceled 终态响应；旧 turn 后续不得再发失败/正文帧。
            // 该标记只控制输出生命周期，绝不修改下一条消息的上下文。
            markTurnCanceled(sessionId, ownerTaskId);
            const session = getSession(sessionId);
            for (const entry of session?.tasks ?? []) {
              session?.outboundQueue.purge(entry.taskId);
            }
          }
        } else {
          log.log(`[TASKS_CANCEL] No active embedded run for sessionKey, nothing to abort`);
        }
      }

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

    // 🔑 先判断是否已有任务；新 task 的身份在 steer 成败明确后再注册，
    // 避免回退期间旧 turn 把输出误挂到新 taskId。
    const isUpdate = hasActiveTask(parsed.sessionId);

    if (isUpdate) {
      log.log(`[BOT] STEER MODE - Second message detected, new taskId=${parsed.taskId}`);
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
    // 低版本判定（低于 11.7.9.310）：本 turn 所有出站帧 isNew 置 false
    markAppVersion(parsed.taskId, appVer);
    const sdkApiVersion = extractSdkApiVersion(parsed.parts);
    if (sdkApiVersion) {
      log.log(`[BOT] Extracted sdk_api_version: ${sdkApiVersion}`);
    }

    // Extract modelName if present (used by provider.ts to override model.id)
    const modelName = extractModelName(parsed.parts);
    if (modelName) {
      log.log(`[BOT] Extracted modelName: ${modelName}`);
    }
    const modelCapabilities = extractModelInput(parsed.parts);
    log.log(`[MODEL-INPUT] source=${modelCapabilities.source}, input=${modelCapabilities.input.join(",")}`);
    const runCrossTaskContext = extractRunCrossTaskContext(parsed.parts);

    // Resolve configuration (needed for status updates)
    const config = resolveXYConfig(cfg);
    cacheXYConfig(config);

    // 低版本链路（app_ver < 11.7.9.310）：按合并前 0730 的下发逻辑 ——
    // 直发初始 status-update，不发 DisplayTaskCardData 起始卡。
    // 新版本链路：下发 DisplayTaskCardData 起始卡（index=1，任务正在处理中）。
    // 走会话出站队列而非直发，排在上一 turn 可能在途的终态帧之后（steer 场景）；
    // 配对卡的 final 帧由 reply-dispatcher / conversation-manager 在对话轮结束时下发。
    if (isLegacyAppVersion(parsed.taskId)) {
      log.log(`[BOT] Sending initial status update (legacy)`);
      void legacySendStatusUpdate({
        config,
        sessionId: parsed.sessionId,
        taskId: parsed.taskId,
        messageId: parsed.messageId,
        text: "任务正在处理中，请稍候~",
        state: "working",
      }).catch((err) => {
        log.error(`Failed to send initial status update (legacy):`, err);
      });
    } else {
      const startSession = getOrCreateSession(parsed.sessionId);
      const startTaskId = parsed.taskId;
      const startMessageId = parsed.messageId;
      startSession.outboundQueue.enqueue({
        taskId: startTaskId,
        label: "task-card-start",
        send: () =>
          sendDisplayTaskCardData({
            config,
            sessionId: parsed.sessionId,
            taskId: startTaskId,
            messageId: startMessageId,
            index: 1,
            stepName: "任务正在处理中",
            isFinal: false,
          }),
      });
    }

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

    // Bind sessionKey→A2A identity only after full-turn admission below.
    // Direct steer preserves the older run's subagent ownership mapping.

    // Check for ACP runtime binding on this A2A conversation
    const runtimeRoute = resolveRuntimeConversationBindingRoute({
      route,
      channel: "xiaoyi-channel",
      accountId,
      conversationId: parsed.sessionId,
    });
    route = runtimeRoute.route;
    if (runtimeRoute.bindingRecord) {
      log.log(
        runtimeRoute.boundSessionKey
          ? `[BOT] routed via bound conversation ${parsed.sessionId} -> ${runtimeRoute.boundSessionKey}`
          : `[BOT] plugin-bound conversation ${parsed.sessionId}`,
      );
    }

    // Extract text and files from parts
    const text = extractTextFromParts(parsed.parts);
    let textForAgent = text || "";

    // Self-evolution keyword nudge — only for real user messages
    if (route.sessionKey && textForAgent) {
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
    // ── Build message and dispatch via auto-reply pipeline ──────────
    // 首条消息和 steer 回退都走此统一 dispatch 路径。

    // File download — for both first message and steer messages
    let mediaPayload: ReturnType<typeof buildXYMediaPayload> = {};
    const fileParts = extractFileParts(parsed.parts);
    const downloadedFiles = await downloadFilesFromParts(fileParts, undefined,
      modelCapabilities.supportsNativeImages ? { maxImageBytes: NATIVE_IMAGE_MAX_BYTES } : undefined);
    log.log(`[BOT] Downloaded ${downloadedFiles.length} file(s)`);
    mediaPayload = buildXYMediaPayload(downloadedFiles);
    const imageParts = fileParts.filter(isImageAttachment);
    let nativeImages: Awaited<ReturnType<typeof loadNativeImages>> = [];
    if (modelCapabilities.supportsNativeImages && imageParts.length > 0) {
      try {
        const downloadedImages = downloadedFiles.filter(isImageAttachment);
        if (downloadedImages.length !== imageParts.length) {
          throw new NativeImageInputError("部分图片下载失败或超过大小限制，请重新上传后重试。");
        }
        nativeImages = await loadNativeImages(downloadedImages, cfg);
        log.log(`[MODEL-INPUT] native images expected=${imageParts.length}, loaded=${nativeImages.length}`);
      } catch (err) {
        const text = err instanceof NativeImageInputError
          ? err.message
          : "图片处理失败，请检查图片格式和大小后重试。";
        log.error(`[MODEL-INPUT] Native image preparation failed:`, err);
        await failBeforeDispatch({
          config, sessionId: parsed.sessionId, taskId: parsed.taskId,
          messageId: parsed.messageId, text, stepName: "图片处理失败",
        });
        return;
      }
    }
    const requiresNewTurn = params.forceNewTurn || nativeImages.length > 0;

    // 🔑 对于 steer 消息，将文件路径附加到消息文本中。
    // auto-reply 管道的 steer 注入只携带 prompt 文本（followupRun.prompt），
    // 不携带 mediaPayload，所以模型需要以文本形式看到附件路径。
    if (isUpdate && !requiresNewTurn && mediaPayload.MediaPaths?.length) {
      const fileHint = `\n【用户上传附件】：${JSON.stringify(mediaPayload.MediaPaths)}`;
      textForAgent = `${textForAgent}${fileHint}`;
      log.log(`[BOT] Steer: appended file paths to text`);
    }

    // 🔑 Direct steer: bypass dispatchReplyFromConfig entirely and inject the
    // message directly into the active embedded agent run (via 对话管理层
    // steer 服务). This avoids the per-session ReplyOperation lock in
    // admitReplyTurn which would otherwise block the steer message until the
    // first message completes — making steer indistinguishable from a followup.
    //
    // 直接注入失败时，先等旧 dispatch 收尾，再落回普通 tasks/send 派发：
    // 活跃 run 已关闭或正在退出时，避免新旧 turn 并发争用 session 写锁。
    // Legacy requests without a capability declaration retain the existing
    // text fallback policy unless admission explicitly requires a new turn.
    const strictFullTurn = requiresNewTurn ||
      (modelCapabilities.source === "request" && Boolean(modelName));
    let steerFailReason: string | undefined;
    if (isUpdate && route.sessionKey) {
      const previousTaskId = getCurrentTaskId(parsed.sessionId);
      const previousMessageId = getCurrentMessageId(parsed.sessionId);
      const steerResult = requiresNewTurn
        ? { ok: false as const, reason: "new-turn-required" }
        : tryDirectSteer({
            sessionId: parsed.sessionId,
            sessionKey: route.sessionKey,
            text: textForAgent,
            source: "user",
          });
      if (steerResult.ok) {
        if (previousTaskId && previousMessageId) {
          // Preserve upstream #81: close the previous device task without
          // canceling the embedded run receiving this text steer.
          try {
            await sendA2AResponse({
              config,
              sessionId: parsed.sessionId,
              taskId: previousTaskId,
              messageId: previousMessageId,
              text: "",
              append: true,
              final: true,
            });
          } catch (err) {
            log.error(`[BOT-STEER] Failed to close previous device task:`, err);
          }
        }
        registerTask(parsed.sessionId, parsed.taskId, parsed.messageId);
        log.log(`[BOT-STEER] Direct steer succeeded — message injected into active run`);
        // Steer message taskId stays in the binding so getActiveTaskId()
        // resolves to the latest taskId for onPartialReply replies.
        // Cleanup happens via the original dispatcher's onIdleComplete →
        // completeTask(sessionId) which removes the entire binding.
        return;
      }
      steerFailReason = (steerResult as { reason: string }).reason;
      log.log(`[BOT-STEER] Direct steer failed (${steerFailReason}), waiting for previous turn before re-dispatch`);
      // 队列关闭或 run 已消失时，旧 dispatch 仍可能持有 session 写锁。
      // 等它完成收尾再开新 turn，避免并发写锁竞争和 60s 超时。
      await params.waitForPreviousTurn?.();
      // Preserve the existing permissive 3s fallback only for legacy text turns.
      if (!strictFullTurn) {
        await waitForChannelTurnReady(parsed.sessionId, route.sessionKey, log);
      }
    }

    // This check is independent of channel task tracking: the SDK may retain a
    // streaming run after our task chain has cleared, including canceled turns.
    if (strictFullTurn) {
      const readiness = await waitForSdkTurnIdle(route.sessionKey, log);
      if (readiness !== "idle") {
        const text = readiness === "timeout"
          ? "上一条任务仍在处理中，本次请求暂未执行，请稍后重试。"
          : "暂时无法确认会话状态，本次请求暂未执行，请稍后重试。";
        log.warn(`[BOT-DISPATCH] Full turn rejected: SDK readiness=${readiness}`);
        await failBeforeDispatch({
          config, sessionId: parsed.sessionId, taskId: parsed.taskId,
          messageId: parsed.messageId, text, stepName: "请求暂未执行",
        });
        return;
      }
    }

    registerTask(parsed.sessionId, parsed.taskId, parsed.messageId);
    if (!isUpdate || ((steerFailReason === "no-active-run" || strictFullTurn) &&
        !hasWaitState(parsed.sessionId))) {
      bindSessionKey(route.sessionKey, parsed.sessionId, parsed.taskId, parsed.messageId);
    }
    if (isUpdate) log.log(`[BOT-STEER] Previous turn settled, re-dispatching as a new turn`);

    // Update selection only after new-turn admission; an incoming steer must
    // never mutate the model selected by an older in-flight run.
    // ALS only: no registerSession. The sessionContext built below is handed
    // to runWithSessionContext() inside withReplyDispatcher.run, which is the
    // single wrap point for the whole agent turn.
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

    let dispatchCfg = cfg;
    if (modelCapabilities.supportsNativeImages) {
      dispatchCfg = {
        ...dispatchCfg,
        tools: {
          ...dispatchCfg.tools,
          media: {
            ...dispatchCfg.tools?.media,
            image: { ...dispatchCfg.tools?.media?.image, enabled: false },
          },
        },
      };
    }
    if (requiresNewTurn) {
      // Runtime queue resolution accepts plugin channel ids as overrides.
      const byChannel = { ...dispatchCfg.messages?.queue?.byChannel };
      byChannel["xiaoyi-channel"] = "followup";
      dispatchCfg = {
        ...dispatchCfg,
        messages: {
          ...dispatchCfg.messages,
          queue: {
            ...dispatchCfg.messages?.queue,
            mode: "followup",
            byChannel,
          },
        },
      };
    }

    // Resolve envelope format options (following feishu pattern)
    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);

    // Build message body with speaker prefix (following feishu pattern)
    const speaker = parsed.sessionId;
    const messageBody = `${speaker}: ${textForAgent}`;

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

    // 🔑 创建dispatcher
    log.log(`[BOT-DISPATCHER] Creating reply dispatcher, isSteer=${isUpdate}, sessionKey=${route.sessionKey}`);

    // Cleanup: 必须在 onIdle 内部执行（参见 reply-dispatcher.ts 中 onIdleComplete 的注释）
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      log.log(`[BOT] Cleanup started`);
      // Check for pending subagent wait on this session
      const superseded = isTurnSuperseded(parsed.sessionId, parsed.taskId);
      const canceled = isTurnCanceled(parsed.sessionId, parsed.taskId);
      const pendingWait = !superseded && !canceled
        ? getWaitState(parsed.sessionId, parsed.taskId) ??
          (hasWaitState(parsed.sessionId) ? { deliveredCompletions: 0, expectedCompletions: 1 } : null)
        : null;
      if (pendingWait && pendingWait.deliveredCompletions < pendingWait.expectedCompletions) {
        // Subagent wait active — skip cleanup, session stays alive
        log.log(`[BOT] Cleanup suppressed — subagent wait active on session, taskId=${parsed.taskId}`);
        cleaned = false;
        return;
      }
      // 被新 dispatcher 接替的旧 turn 只移除自己的身份；当前 turn（含直接
      // steer 合并进原 dispatcher 的新 task）仍由本 dispatcher 统一收尾。
      completeTask(parsed.sessionId, superseded ? parsed.taskId : undefined);
      log.log(`[BOT] Cleanup completed`);
    };

    // 低版本链路：使用合并前 0730 的 dispatcher（src/legacy/，完全独立实现）
    const dispatcherParams = {
      cfg,
      runtime,
      sessionId: parsed.sessionId,
      taskId: parsed.taskId,
      messageId: parsed.messageId,
      accountId: route.accountId,
      onIdleComplete: cleanup,
    };
    // 活跃 run 判定只给主链路：空 idle 时用于识别「消息被排成 followup」。
    // 低版本链路参数形状独立，不额外透传，保持其原行为零变化。
    const { dispatcher, replyOptions, markDispatchIdle, startStatusInterval } =
      isLegacyAppVersion(parsed.taskId)
        ? createLegacyReplyDispatcher(dispatcherParams)
        : createXYReplyDispatcher({
            ...dispatcherParams,
            isUpstreamRunActive: () => {
              try {
                return !!resolveActiveEmbeddedRunSessionId(route.sessionKey);
              } catch {
                return false;
              }
            },
          });

    // 每个新 dispatcher 都接管心跳；直接 steer 不创建 dispatcher，沿用原心跳。
    startStatusInterval();

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
      modelCapabilities,
      runCrossTaskContext: runCrossTaskContext ?? undefined,
    };

    log.log(`[BOT-DISPATCH] withReplyDispatcher starting, sessionKey=${route.sessionKey}`);

    // 🔑 登记本 turn 在途（onIdle 入口 / onSettled 兜底清除）：subagent 终态
    // 帧的时机门控据此判断"session 内仍有 turn 在流式输出"，防止 final:true
    // 提前截断在途回复。steer 直接注入成功的路径在上方已 return，不会登记。
    markTurnInflight(parsed.sessionId, parsed.taskId);

    await core.channel.reply.withReplyDispatcher({
      dispatcher,
      onSettled: async () => {
        log.log(`[BOT] onSettled`);

        // 🔑 兜底清除本 turn 在途标记（正常路径 onIdle 入口已清除；onIdle
        // 未执行的异常路径靠此处，避免时机门控永久推迟 subagent 终态帧）。
        clearTurnInflight(parsed.sessionId, parsed.taskId);

        if (
          isTurnSuperseded(parsed.sessionId, parsed.taskId) ||
          isTurnCanceled(parsed.sessionId, parsed.taskId)
        ) {
          log.log(`[BOT] Ignoring settled callback for canceled/superseded turn`);
          return;
        }

        // Subagent wait state: if parent has pending subagents, mark settled
        // and defer finalization. Cleanup is suppressed so the session stays alive.
        const pendingWait = getWaitState(parsed.sessionId, parsed.taskId) ?? getWaitState(parsed.sessionId);
        if (pendingWait && !pendingWait.parentSettled) {
          const transition = markParentSettled(parsed.sessionId, pendingWait.taskId);
          if (transition?.shouldFinalize) {
            // All completions arrived before parent settled → finalize now
            // 低版本链路走 legacy 交付（与合并前 0730 一致），新版本走主链路
            if (isLegacyAppVersion(transition.state.taskId)) {
              const { deliverLegacySubagentFinalResult } = await import("../legacy/keepalive.js");
              await deliverLegacySubagentFinalResult({
                state: transition.state,
                reason: "all-subagent-results-delivered-before-parent-settled",
              });
            } else {
              const { deliverSubagentFinalResult } = await import("../conversation/conversation-manager.js");
              await deliverSubagentFinalResult({
                state: transition.state,
                reason: "all-subagent-results-delivered-before-parent-settled",
              });
            }
            log.log(`[BOT] Subagent wait complete on parent settled; final response delivered`);
          } else {
            log.log(`[BOT] Subagent wait active, preserving session context for completion`);
          }
          return;
        }

        // 🔑 安全网：等待态已就绪（父 settled + 全部完成）但尚未交付 ——
        // 例如 finalize 因本 turn 当时在途被时机门控推迟，而本 turn 的
        // onIdle 未走到 defer 分支（异常/竞态路径）。幂等，已交付时为 no-op。
        if (
          pendingWait &&
          pendingWait.deliveredCompletions >= pendingWait.expectedCompletions
        ) {
          const { deliverSubagentFinalResult } = await import("../conversation/conversation-manager.js");
          await deliverSubagentFinalResult({
            state: pendingWait,
            reason: "ready-at-onsettled",
          });
        }

        // cleanup 已由 onIdleComplete 在 onIdle 的 finally 中执行。
        // onSettled 不做任何清理（直接在这里清理会发生 race condition）。
      },
      run: async () => {
        const releaseDispatchInitGate = params.acquireDispatchInitGate
          ? await params.acquireDispatchInitGate()
          : () => {};
        try {
          // 仅在 dispatch 初始化期间持有全局门；长任务执行与 steer 回退等待不占门。
          const dispatchPromise = runWithSessionContext(sessionContext, async () => {
            log.log(`[ALS-PROOF] bot entered dispatch scope sessionId=${(sessionContext as any).sessionId} taskId=${(sessionContext as any).taskId} isSteer=${isUpdate}`);
            log.log(`[BOT-DISPATCH] dispatchReplyFromConfig starting, body.length=${(ctxPayload.Body as string)?.length ?? 0}`);
            try {
              params.onTurnAdmitted?.();
              const result = await core.channel.reply.dispatchReplyFromConfig({
                ctx: ctxPayload,
                cfg: dispatchCfg,
                dispatcher,
                replyOptions: nativeImages.length > 0
                  ? { ...replyOptions, images: nativeImages, imageOrder: nativeImages.map(() => "inline" as const) }
                  : replyOptions,
              });

              log.log(`[BOT-DISPATCH] dispatchReplyFromConfig returned, result=${JSON.stringify(result)}`);

              return result;
            } catch (dispatchErr) {
              log.error(`[BOT-DISPATCH] dispatchReplyFromConfig threw: ${dispatchErr instanceof Error ? `${dispatchErr.name}: ${dispatchErr.message}` : String(dispatchErr)}`, dispatchErr instanceof Error ? dispatchErr.stack?.slice(0, 500) : undefined);
              throw dispatchErr;
            }
          });

          return dispatchPromise;
        } finally {
          releaseDispatchInitGate();
        }
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
        completeTask(sessionId, isTurnSuperseded(sessionId, errTaskId) ? errTaskId : undefined);
        // 清理在途标记（dispatch 中途异常时 onIdle/onSettled 可能未执行，
        // 避免残留标记让 subagent 终态帧的时机门控永久推迟）
        if (errTaskId) {
          clearTurnInflight(sessionId, errTaskId);
        }

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
 * 固定会话（pinnedSessionIds，如 "00000000"）的 clearContext 隔离实现。
 *
 * 通过 gateway RPC `sessions.reset` 在同一 sessionKey 下轮换 openclaw 内层
 * sessionId：归档旧 transcript、abort 在途 run、停 subagent、清 bootstrap
 * 缓存，下一条消息即进入全新上下文。sessionKey 与 A2A sessionId 均不变，
 * 因此 sessionKey 反解、bindSessionKey、ACP binding 等映射全部不受影响。
 *
 * reset 失败只记日志不抛出（clearContext 响应已先行发出，不能让客户端挂起）；
 * finally 中清理 channel 侧以 A2A sessionId 为 key 的内存态，避免残留导致
 * 下一条消息被 hasActiveTask 误判为 steer、或被残留 wait state 抑制 cleanup。
 */
async function resetPinnedOpenclawSession(params: {
  cfg: ClawdbotConfig;
  core: any;
  accountId: string;
  sessionId: string;
}): Promise<void> {
  const { cfg, core, accountId, sessionId } = params;
  const log = logger.withContext(sessionId, "");
  try {
    // 用与正常消息相同的路由推导拿到 sessionKey（agent:main:direct:<sessionId>）
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "xiaoyi-channel",
      accountId,
      peer: {
        kind: "direct" as const,
        id: sessionId,
      },
    });
    log.log(`[CLEAR_CONTEXT] Resetting pinned session via gateway RPC, sessionKey=${route.sessionKey}`);
    // 在途 run 的 abort+等待可能长达 ~15s（openclaw 内部超时），RPC 超时给足余量
    await callGatewayTool(
      "sessions.reset",
      { timeoutMs: 25_000 },
      { key: route.sessionKey, reason: "new" },
    );
    log.log(`[CLEAR_CONTEXT] sessions.reset succeeded, sessionKey=${route.sessionKey}`);
  } catch (err) {
    log.error(`[CLEAR_CONTEXT] sessions.reset failed (context may not be isolated):`, err);
  } finally {
    try {
      const currentTaskId = getCurrentTaskId(sessionId);
      if (currentTaskId) {
        clearTurnInflight(sessionId, currentTaskId);
      }
      // clearWaitState 单次只清一条，循环清空该会话的全部残留等待态
      while (clearWaitState(sessionId, "clear-context")) {
        // keep draining
      }
      completeTask(sessionId);
      clearPendingApproval(sessionId);
      log.log(`[CLEAR_CONTEXT] Local conversation state cleaned`);
    } catch (cleanupErr) {
      log.error(`[CLEAR_CONTEXT] Failed to clean local conversation state:`, cleanupErr);
    }
  }
}

/**
 * Build media payload for inbound context.
 * Following feishu pattern: buildFeishuMediaPayload().
 *
 * @param mediaList - Downloaded files with local paths
 */
function buildXYMediaPayload(
  mediaList: Array<{ path: string; name: string; mimeType: string; uri: string }>,
): {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
} {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((media) => media.path);
  const mediaUrls = mediaList.map((media) => media.uri);
  const mediaTypes = mediaList.map((media) => media.mimeType || "application/octet-stream");
  return {
    MediaPath: first?.path,
    MediaType: first?.mimeType,
    MediaUrl: first?.uri,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}

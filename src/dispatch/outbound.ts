// Outbound adapter for XY channel
// Following feishu/outbound.ts pattern
// NOTE: Using any for compatibility with SDK 2026.3.24
type ChannelOutboundAdapter = any;
import { resolveXYConfig } from "../config.js";
import { XYFileUploadService } from "../file-upload.js";
import { sendWsFrame, pushBroadcast } from "../conversation/outbound-gateway.js";
import { gateCronSendText, closeCronTurn } from "../conversation/cron-buffer.js";
import { getCurrentSessionContext } from "../tools/session-manager.js";
import {
  getWaitState,
  addCompletionText,
} from "../conversation/conversation-manager.js";
import { savePushData } from "../utils/pushdata-manager.js";
import { logger } from "../utils/logger.js";

// Special marker for default push delivery when no target is specified
const DEFAULT_PUSH_MARKER = "default";

// File extension to MIME type mapping
const FILE_TYPE_TO_MIME_TYPE: Record<string, string> = {
  txt: "text/plain",
  html: "text/html",
  css: "text/css",
  js: "application/javascript",
  json: "application/json",
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

/**
 * Get MIME type from file extension
 */
function getMimeTypeFromFilename(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (extension && FILE_TYPE_TO_MIME_TYPE[extension]) {
    return FILE_TYPE_TO_MIME_TYPE[extension];
  }
  return "text/plain"; // Default fallback
}

/**
 * Outbound adapter for sending messages from OpenClaw to XY.
 * Uses Push service for direct message delivery.
 */
export const xyOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: 4000,

  /**
   * Resolve delivery target for XY channel.
   * When no target is specified (e.g., in cron jobs with announce mode),
   * returns a default marker that will be handled by sendText.
   *
   * For message tool calls, if only sessionId is provided, it will look up
   * the active session context to construct the full "sessionId::taskId" format.
   */
  resolveTarget: ({ cfg, to, accountId, mode }) => {
    // If no target provided, use default marker for push delivery
    if (!to || to.trim() === "") {
      logger.log(`[xyOutbound.resolveTarget] No target specified, using default push marker`);
      return {
        ok: true,
        to: DEFAULT_PUSH_MARKER,
      };
    }

    const trimmedTo = to.trim();

    // If the target doesn't contain "::", try to enhance it with taskId from session context
    if (!trimmedTo.includes("::")) {
      logger.log(`[xyOutbound.resolveTarget] Target "${trimmedTo}" missing taskId, looking up session context`);

      // Try ALS context first (normal agent turn)
      const sessionContext = getCurrentSessionContext();
      if (sessionContext && sessionContext.sessionId === trimmedTo) {
        const enhancedTarget = `${trimmedTo}::${sessionContext.taskId}`;
        logger.log(`[xyOutbound.resolveTarget] Enhanced target from ALS: ${enhancedTarget}`);
        return {
          ok: true,
          to: enhancedTarget,
        };
      }

      // Fallback: subagent wait state (ALS is null for subagent completion deliveries)
      const waitState = getWaitState(trimmedTo);
      if (waitState) {
        const enhancedTarget = `${waitState.sessionId}::${waitState.taskId}`;
        logger.withContext(waitState.sessionId, waitState.taskId).log(
          `[xyOutbound.resolveTarget] Enhanced target from subagent wait state: ${enhancedTarget}`,
        );
        return {
          ok: true,
          to: enhancedTarget,
        };
      }

      logger.log(`[xyOutbound.resolveTarget] Could not find matching session context or wait state for "${trimmedTo}"`);
      // Still return the original target, but it may fail in sendMedia
    }

    // Otherwise, use the provided target (either already in correct format or for sendText)
    logger.log(`[xyOutbound.resolveTarget] Using provided target:`, trimmedTo);
    return {
      ok: true,
      to: trimmedTo,
    };
  },

  sendText: async ({ cfg, to, text, accountId }) => {

    // Resolve configuration
    const config = resolveXYConfig(cfg);

    // ── Cron 聚合闸门（对话管理层）─────────────────────────────
    // 定时任务执行期间的所有 sendText 一律吞掉（返回合成成功，保证
    // openclaw durable-delivery 记账正常），只放行 cron run 结束后的
    // announce 最终结果（唯一一条 push）。
    // announce 时 meta 是 gate 同步快照的 cron 元数据（jobId/title），
    // 随 push 下发供客户端识别来源；其余路径 meta 为 null。
    // announceLike（无显式 target：to 为空或 DEFAULT_PUSH_MARKER）用于并发
    // 场景下把 announce 与中间消息粗路由到正确的 job turn —— sendText 层
    // 拿不到 jobId/runId。
    const announceLike = !to || to === DEFAULT_PUSH_MARKER;
    const { gate: cronGate, meta: cronMeta } = gateCronSendText(
      text as string,
      announceLike,
      config,
    );
    if (cronGate === "swallow") {
      logger.log(`[xyOutbound.sendText] Cron turn active — swallowing intermediate sendText, len=${(text as string)?.length ?? 0}`);
      return {
        channel: "xiaoyi-channel",
        messageId: `cron-swallowed-${Date.now()}`,
        chatId: typeof to === "string" ? to : "",
      };
    }

    // ── Subagent completion text capture + push 抑制 ─────────────
    // Subagent completions may arrive here when openclaw's announce
    // flow delivers through the channel outbound. We capture the text
    // for the final A2A response but do NOT track delivery count here.
    // Delivery tracking is done by the subagent_ended hook (index.ts).
    //
    // 正常对话的 subagent announce 一律不发 push：结果由保活机制经
    // A2A final 帧交付，push webhook 通知冗余。返回合成成功（与 cron
    // 吞没路径同理），保证 openclaw durable-delivery 记账正常，避免
    // 触发 direct-primary fallback 重试。
    // cron 的 announce 不受此分支影响：cron sendText 无 target
    // （DEFAULT_PUSH_MARKER），且 cron 会话不存在 wait state，push 照常。
    if (to && to !== DEFAULT_PUSH_MARKER) {
      const [targetSessionId, targetTaskId] = String(to).split("::");
      const waitState = getWaitState(targetSessionId, targetTaskId);

      // 不能用 ALS taskId 区分来源：实测 openclaw 的 subagent announce 投递
      // 同样携带父会话 ALS 上下文（resolveTarget 据此增强 target），ALS guard
      // 会把 announce 误判为父 turn 自己的 sendText 而漏捕获。
      // 改用 parentSettled 区分：父 run 存活期间的 sendText 是父自己的 message
      // 工具调用（不捕获、push 照常）；父 settle 后命中 waitState 的 sendText
      // 即为 subagent 完成结果的 announce 投递（捕获 + 吞掉 push）。
      // 捕获窗口以 finalDeliveryStarted 为准（而非 finalizationClaimed）：
      // finalizationClaimed 在 markSubagentEnded 时就置位，若 announce 的
      // sendText 晚于 subagent_ended hook 到达（如长文本被 textChunkLimit
      // 分片、投递时序竞争），claim 会提前关闭捕获导致内容丢失——配合
      // push 抑制，丢失是永久的。finalDeliveryStarted 在 grace 结束后、
      // final 帧发送前才置位，grace 期间迟到的文本仍能并入 final。
      const isFromWaitState = waitState && waitState.parentSettled;

      if (isFromWaitState) {
        const log = logger.withContext(waitState.sessionId, waitState.taskId);
        if (!waitState.finalDeliveryStarted) {
          log.log(`[xyOutbound.sendText] Subagent completion text captured, len=${(text as string)?.length ?? 0}`);
          addCompletionText(targetSessionId, targetTaskId, text as string);
          log.log(`[xyOutbound.sendText] Subagent announce — swallowing push (result delivered via A2A final frame)`);
          return {
            channel: "xiaoyi-channel",
            messageId: `subagent-swallowed-${Date.now()}`,
            chatId: typeof to === "string" ? to : "",
          };
        }
        // final 帧已开始交付：不再捕获也不再吞没，fall through 走 push 兜底，
        // 避免迟到的 announce 文本被静默丢弃。
        log.log(`[xyOutbound.sendText] Subagent announce arrived after final delivery started — falling back to push`);
      }
    }
    // ── End subagent text capture ───────────────────────────────

    // Handle default push marker (for cron jobs without explicit target)
    let actualTo = to;
    if (to === DEFAULT_PUSH_MARKER) {
      logger.log(`[xyOutbound.sendText] Using default push delivery (no specific target)`);
      // For push notifications, we don't need a specific target
      // The push service will handle it based on config
      actualTo = config.defaultSessionId || "";
    }

    // 1. 持久化推送消息内容，获取 pushDataId（cron announce 时附带 cron 元数据）
    logger.log(`[xyOutbound.sendText] Saving push data to local storage...`);
    let pushDataId: string;
    try {
      pushDataId = await savePushData(text, cronMeta
        ? { cronJobId: cronMeta.jobId, cronTitle: cronMeta.jobTitle }
        : undefined);
      logger.log(`[xyOutbound.sendText] Push data saved with ID: ${pushDataId.substring(0, 20)}`);
    } catch (error) {
      logger.error(`[xyOutbound.sendText] Failed to save push data:`, error);
      // 如果持久化失败，仍然继续发送（不阻塞主流程）
      pushDataId = "";
    }

    // 2. 经 outbound-gateway 广播推送（pushId 加载与多设备遍历收口在网关内）
    const title = text.split("\n")[0].slice(0, 57);
    const pushText = text.length > 1000 ? text.slice(0, 1000) : text;

    logger.log(`[xyOutbound.sendText] Broadcasting push via outbound-gateway...`);
    await pushBroadcast({
      config,
      text: pushText,
      title,
      to: actualTo,
      pushDataId,
      ...(cronMeta ? { cronJobId: cronMeta.jobId, cronTitle: cronMeta.jobTitle } : {}),
    });

    // announce 最终结果已送达 —— 关闭该 job 的 cron turn（并发下不误关其它 job）
    if (cronGate === "announce") {
      closeCronTurn(cronMeta?.jobId, "announce-delivered");
    }

    // Return message info
    return {
      channel: "xiaoyi-channel",
      messageId: pushDataId || Date.now().toString(),
      chatId: actualTo,
    };
  },

  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, mediaLocalRoots }) => {

    // Parse to: "sessionId::taskId"
    const parts = to.split("::");
    if (parts.length !== 2) {
      logger.error(`Invalid to format: "${to}". Expected "sessionId::taskId"`);
      throw new Error(`Invalid to format: "${to}". Expected "sessionId::taskId"`);
    }
    const [sessionId, taskId] = parts;

    // Resolve configuration
    const config = resolveXYConfig(cfg);

    // Create upload service
    const uploadService = new XYFileUploadService(
      config.fileUploadUrl,
      config.apiKey,
      config.uid
    );

    // Validate mediaUrl
    if (!mediaUrl) {
      logger.error("mediaUrl is required for sendMedia");
      throw new Error("mediaUrl is required for sendMedia");
    }

    // Upload file (completeAndQuery returns both fileId and fileUrl)
    const { fileId, fileUrl } = await uploadService.uploadFileAndGetIdAndUrl(mediaUrl);

    // Check if fileId is empty (should not happen if uploadFileAndGetIdAndUrl throws on failure)
    if (!fileId) {
      logger.error(`File upload returned empty fileId for: ${mediaUrl}`);
      throw new Error(`File upload returned empty fileId for: ${mediaUrl}`);
    }

    logger.log(`[xyOutbound.sendMedia] File uploaded:`, {
      fileId,
      fileUrl,
      taskId,
    });

    // Get filename and mime type from mediaUrl
    // mediaUrl may be a local file path or URL
    const fileName = mediaUrl.split("/").pop() || "unknown";
    const mimeType = getMimeTypeFromFilename(fileName);

    // Build agent_response payload（经 outbound-gateway 统一封装信封并发送）
    const payload = {
      jsonrpc: "2.0",
      id: taskId,
      result: {
        kind: "artifact-update",
        append: true,
        lastChunk: false,
        final: false,
        artifact: {
          artifactId: taskId,
          parts: [
            {
              kind: "file",
              file: {
                name: fileName,
                mimeType: mimeType,
                fileId: fileId,
                fileUrl: fileUrl,
              },
            },
          ],
        },
      },
      error: { code: 0 },
    };

    await sendWsFrame({ config, sessionId, taskId, payload });

    logger.log(`[xyOutbound.sendMedia] WebSocket message sent successfully`);

    // Return message info
    return {
      channel: "xiaoyi-channel",
      messageId: fileId,
      chatId: to,
    };
  },
};

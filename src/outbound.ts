// Outbound adapter for XY channel
// Following feishu/outbound.ts pattern
// NOTE: Using any for compatibility with SDK 2026.3.24
import os from "os";
import type { OutboundWebSocketMessage } from "./types.js";

type ChannelOutboundAdapter = any;
import { resolveXYConfig } from "./config.js";
import { XYFileUploadService } from "./file-upload.js";
import { XYPushService } from "./push.js";
import { getCurrentSessionContext } from "./tools/session-manager.js";
import {
  getWaitState,
  addCompletionText,
  clearWaitState,
} from "./subagent-wait-state.js";
import { decrementTaskIdRef } from "./task-manager.js";
import { sendA2AResponse, sendStatusUpdate } from "./formatter.js";
import { savePushData } from "./utils/pushdata-manager.js";
import { getAllPushIds } from "./utils/pushid-manager.js";
import { logger } from "./utils/logger.js";

// Special marker for default push delivery when no target is specified
const DEFAULT_PUSH_MARKER = "default";

// ─── Subagent completion delivery ──────────────────────────────

export async function deliverSubagentFinalResult(params: {
  config: ReturnType<typeof resolveXYConfig>;
  state: import("./subagent-wait-state.js").SubagentWaitState;
  reason?: string;
  text?: string;
}): Promise<void> {
  const { config, state, reason, text } = params;
  const log = logger.withContext(state.sessionId, state.taskId);

  const finalText = state.completionTexts.length > 0
    ? state.completionTexts.join("\n\n")
    : (text || undefined) ?? "子任务已完成";

  await sendA2AResponse({
    config,
    sessionId: state.sessionId,
    taskId: state.taskId,
    messageId: state.messageId,
    text: finalText,
    append: false,
    final: true,
  });

  clearWaitState(
    state.sessionId,
    reason ?? "all-subagent-results-delivered",
    state.taskId,
  );
  decrementTaskIdRef(state.sessionId, state.taskId);
  log.log(`[xyOutbound] Subagent final delivered to original A2A task, reason=${reason}`);
}

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

    // ── Subagent completion text capture ─────────────────────────
    // Subagent completions may arrive here when openclaw's announce
    // flow delivers through the channel outbound. We capture the text
    // for the final A2A response but do NOT track delivery count here.
    // Delivery tracking is done by the subagent_ended hook (index.ts).
    //
    // IMPORTANT: We do NOT return early here. The OpenClaw core's announce
    // flow needs sendText to complete normally (push delivery) to avoid
    // triggering the direct-primary fallback retry loop. Text is captured
    // for the A2A final response, but push delivery proceeds normally.
    if (to && to !== DEFAULT_PUSH_MARKER) {
      const [targetSessionId, targetTaskId] = String(to).split("::");
      const waitState = getWaitState(targetSessionId, targetTaskId);
      const alsCtx = getCurrentSessionContext();

      const isFromWaitState = waitState &&
        (!alsCtx || alsCtx.taskId !== targetTaskId);

      if (isFromWaitState && !waitState.finalizationClaimed) {
        const log = logger.withContext(waitState.sessionId, waitState.taskId);
        log.log(`[xyOutbound.sendText] Subagent completion text captured, len=${(text as string)?.length ?? 0}`);
        addCompletionText(targetSessionId, targetTaskId, text as string);
        // Fall through to normal push delivery — core needs sendText to
        // complete normally to avoid retry/announce-failure loops.
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

    // 1. 持久化推送消息内容，获取 pushDataId
    logger.log(`[xyOutbound.sendText] Saving push data to local storage...`);
    let pushDataId: string;
    try {
      pushDataId = await savePushData(text);
      logger.log(`[xyOutbound.sendText] Push data saved with ID: ${pushDataId.substring(0, 20)}`);
    } catch (error) {
      logger.error(`[xyOutbound.sendText] Failed to save push data:`, error);
      // 如果持久化失败，仍然继续发送（不阻塞主流程）
      pushDataId = "";
    }

    // 2. 读取所有 pushId
    logger.log(`[xyOutbound.sendText] Loading all pushIds...`);
    let pushIdList: string[] = [];
    try {
      pushIdList = await getAllPushIds();
      logger.log(`[xyOutbound.sendText] Loaded ${pushIdList.length} pushIds`);
    } catch (error) {
      logger.error(`[xyOutbound.sendText] Failed to load pushIds:`, error);
    }

    // 3. 如果 pushIdList 为空，回退到原有逻辑（使用 config pushId）
    if (pushIdList.length === 0) {
      logger.log(`[xyOutbound.sendText] No pushIds found, falling back to config pushId`);
      pushIdList = [String(config.pushId)];
    }

    // Create push service
    const pushService = new XYPushService(config);

    // Extract title (first 57 chars or first line)
    const title = text.split("\n")[0].slice(0, 57);

    // Truncate push content to max length 1000
    const pushText = text.length > 1000 ? text.slice(0, 1000) : text;

    // 4. 遍历所有 pushId，依次发送推送通知
    logger.log(`[xyOutbound.sendText] Broadcasting to ${pushIdList.length} pushId(s)...`);
    let successCount = 0;
    let failureCount = 0;

    for (const pushId of pushIdList) {
      try {
        // 传入 pushId 和 pushDataId，使用 kind="data" 格式
        await pushService.sendPush(pushText, title, undefined, actualTo, pushDataId, pushId);
        successCount++;
        logger.log(`[xyOutbound.sendText] Sent successfully to pushId: ${pushId.substring(0, 20)}...`);
      } catch (error) {
        failureCount++;
        logger.error(`[xyOutbound.sendText] Failed to send to pushId: ${pushId.substring(0, 20)}...`, error);
        // 单个 pushId 发送失败不影响其他，继续处理下一个
      }
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

    // Upload file
    const fileId = await uploadService.uploadFile(mediaUrl);

    // Check if fileId is empty (should not happen if uploadFile throws on failure)
    if (!fileId) {
      logger.error(`File upload returned empty fileId for: ${mediaUrl}`);
      throw new Error(`File upload returned empty fileId for: ${mediaUrl}`);
    }

    logger.log(`[xyOutbound.sendMedia] File uploaded:`, {
      fileId,
      taskId,
    });

    // Get filename and mime type from mediaUrl
    // mediaUrl may be a local file path or URL
    const fileName = mediaUrl.split("/").pop() || "unknown";
    const mimeType = getMimeTypeFromFilename(fileName);

    // Build agent_response message
    const agentResponse: OutboundWebSocketMessage = {
      msgType: "agent_response",
      agentId: config.agentId,
      sessionId: sessionId,
      taskId: taskId,
      msgDetail: JSON.stringify({
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
                },
              },
            ],
          },
        },
        error: { code: 0 },
        hostname: os.hostname(),
      }),
    };

    // Get WebSocket manager and send message
    const { getXYWebSocketManager } = await import("./client.js");
    const wsManager = getXYWebSocketManager(config);
    await wsManager.sendMessage(sessionId, agentResponse);

    logger.log(`[xyOutbound.sendMedia] WebSocket message sent successfully`);

    // Return message info
    return {
      channel: "xiaoyi-channel",
      messageId: fileId,
      chatId: to,
    };
  },
};

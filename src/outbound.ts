// Outbound adapter for XY channel
// Following feishu/outbound.ts pattern
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import type { OutboundWebSocketMessage } from "./types.js";
import { resolveXYConfig } from "./config.js";
import { XYFileUploadService } from "./file-upload.js";
import { XYPushService } from "./push.js";
import { getLatestSessionContext } from "./tools/session-manager.js";

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
      console.log(`[xyOutbound.resolveTarget] No target specified, using default push marker`);
      return {
        ok: true,
        to: DEFAULT_PUSH_MARKER,
      };
    }

    const trimmedTo = to.trim();

    // If the target doesn't contain "::", try to enhance it with taskId from session context
    if (!trimmedTo.includes("::")) {
      console.log(`[xyOutbound.resolveTarget] Target "${trimmedTo}" missing taskId, looking up session context`);

      // Try to get the latest session context
      const sessionContext = getLatestSessionContext();
      if (sessionContext && sessionContext.sessionId === trimmedTo) {
        const enhancedTarget = `${trimmedTo}::${sessionContext.taskId}`;
        console.log(`[xyOutbound.resolveTarget] Enhanced target: ${enhancedTarget}`);
        return {
          ok: true,
          to: enhancedTarget,
        };
      } else {
        console.log(`[xyOutbound.resolveTarget] Could not find matching session context for "${trimmedTo}"`);
        // Still return the original target, but it may fail in sendMedia
      }
    }

    // Otherwise, use the provided target (either already in correct format or for sendText)
    console.log(`[xyOutbound.resolveTarget] Using provided target:`, trimmedTo);
    return {
      ok: true,
      to: trimmedTo,
    };
  },

  sendText: async ({ cfg, to, text, accountId }) => {
    // Log parameters
    console.log(`[xyOutbound.sendText] Called with:`, {
      to,
      accountId,
      textLength: text?.length || 0,
      textPreview: text?.slice(0, 100),
    });

    // Resolve configuration
    const config = resolveXYConfig(cfg);

    // Handle default push marker (for cron jobs without explicit target)
    let actualTo = to;
    if (to === DEFAULT_PUSH_MARKER) {
      console.log(`[xyOutbound.sendText] Using default push delivery (no specific target)`);
      // For push notifications, we don't need a specific target
      // The push service will handle it based on config
      actualTo = config.defaultSessionId || "";
    }

    // Create push service
    const pushService = new XYPushService(config);

    // Extract title (first 57 chars or first line)
    const title = text.split("\n")[0].slice(0, 57);

    // Send push message (content, title, data, sessionId)
    await pushService.sendPush(text, title, undefined, actualTo);

    console.log(`[xyOutbound.sendText] Completed successfully`);

    // Return message info
    return {
      channel: "xiaoyi-channel",
      messageId: Date.now().toString(),
      chatId: actualTo,
    };
  },

  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, mediaLocalRoots }) => {
    // Log parameters
    console.log(`[xyOutbound.sendMedia] Called with:`, {
      to,
      accountId,
      text,
      mediaUrl,
      mediaLocalRoots,
    });

    // Parse to: "sessionId::taskId"
    const parts = to.split("::");
    if (parts.length !== 2) {
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
      throw new Error("mediaUrl is required for sendMedia");
    }

    // Upload file
    const fileId = await uploadService.uploadFile(mediaUrl);

    // Check if fileId is empty
    if (!fileId) {
      console.log(`[xyOutbound.sendMedia] ⚠️ File upload failed: fileId is empty, aborting sendMedia`);
      return {
        channel: "xiaoyi-channel",
        messageId: "",
        chatId: to,
      };
    }

    console.log(`[xyOutbound.sendMedia] File uploaded:`, {
      fileId,
      sessionId,
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
      }),
    };

    // Get WebSocket manager and send message
    const { getXYWebSocketManager } = await import("./client.js");
    const wsManager = getXYWebSocketManager(config);
    await wsManager.sendMessage(sessionId, agentResponse);

    console.log(`[xyOutbound.sendMedia] WebSocket message sent successfully`);

    // Return message info
    return {
      channel: "xiaoyi-channel",
      messageId: fileId,
      chatId: to,
    };
  },
};

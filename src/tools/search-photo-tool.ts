// Search Photo tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getLatestSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY search photo tool - searches photos in user's gallery.
 * Returns publicly accessible URLs of matching photos based on query description.
 *
 * This tool performs a two-step operation:
 * 1. Search for photos using query description
 * 2. Upload found photos to get publicly accessible URLs
 */
export const searchPhotoTool: any = {
  name: "search_photo",
  label: "Search Photo",
  description: "搜索用户手机图库中的照片。根据图像描述语料检索匹配的照片，并返回照片的可公网访问URL。注意:操作超时时间为120秒,请勿重复调用此工具,如果超时或失败,最多重试一次。",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "图像描述语料，用于检索匹配的照片（例如：'小狗的照片'、'带有键盘的图片'等）",
      },
    },
    required: ["query"],
  },

  async execute(toolCallId: string, params: any) {
    logger.log(`[SEARCH_PHOTO_TOOL] 🚀 Starting execution`);
    logger.log(`[SEARCH_PHOTO_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[SEARCH_PHOTO_TOOL]   - params:`, JSON.stringify(params));
    logger.log(`[SEARCH_PHOTO_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // Validate parameters
    if (!params.query) {
      logger.error(`[SEARCH_PHOTO_TOOL] ❌ Missing required parameter: query`);
      throw new Error("Missing required parameter: query is required");
    }

    // Get session context
    logger.log(`[SEARCH_PHOTO_TOOL] 🔍 Attempting to get session context...`);
    const sessionContext = getLatestSessionContext();

    if (!sessionContext) {
      logger.error(`[SEARCH_PHOTO_TOOL] ❌ FAILED: No active session found!`);
      logger.error(`[SEARCH_PHOTO_TOOL]   - toolCallId: ${toolCallId}`);
      throw new Error("No active XY session found. Search photo tool can only be used during an active conversation.");
    }

    logger.log(`[SEARCH_PHOTO_TOOL] ✅ Session context found`);
    logger.log(`[SEARCH_PHOTO_TOOL]   - sessionId: ${sessionContext.sessionId}`);
    logger.log(`[SEARCH_PHOTO_TOOL]   - taskId: ${sessionContext.taskId}`);
    logger.log(`[SEARCH_PHOTO_TOOL]   - messageId: ${sessionContext.messageId}`);

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    logger.log(`[SEARCH_PHOTO_TOOL] 🔌 Getting WebSocket manager...`);
    const wsManager = getXYWebSocketManager(config);
    logger.log(`[SEARCH_PHOTO_TOOL] ✅ WebSocket manager obtained`);

    // Step 1: Search for photos
    logger.log(`[SEARCH_PHOTO_TOOL] 📸 STEP 1: Searching for photos...`);
    const mediaUris = await searchPhotos(wsManager, config, sessionId, taskId, messageId, params.query);

    if (!mediaUris || mediaUris.length === 0) {
      logger.warn(`[SEARCH_PHOTO_TOOL] ⚠️ No photos found for query: ${params.query}`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ imageUrls: [], message: "未找到匹配的照片" }),
          },
        ],
      };
    }

    logger.log(`[SEARCH_PHOTO_TOOL] ✅ Found ${mediaUris.length} photos`);
    logger.log(`[SEARCH_PHOTO_TOOL]   - mediaUris:`, JSON.stringify(mediaUris));

    // Step 2: Get public URLs for the photos
    logger.log(`[SEARCH_PHOTO_TOOL] 🌐 STEP 2: Getting public URLs for photos...`);
    const imageUrls = await getPhotoUrls(wsManager, config, sessionId, taskId, messageId, mediaUris);

    logger.log(`[SEARCH_PHOTO_TOOL] 🎉 Successfully retrieved ${imageUrls.length} photo URLs`);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ imageUrls }),
        },
      ],
    };
  },
};

/**
 * Step 1: Search for photos using query description
 * Returns array of mediaUri strings
 */
async function searchPhotos(
  wsManager: any,
  config: any,
  sessionId: string,
  taskId: string,
  messageId: string,
  query: string
): Promise<string[]> {
  logger.log(`[SEARCH_PHOTO_TOOL] 📦 Building SearchPhotoVideo command...`);

  const command = {
    header: {
      namespace: "Common",
      name: "Action",
    },
    payload: {
      cardParam: {},
      executeParam: {
        executeMode: "background",
        intentName: "SearchPhotoVideo",
        bundleName: "com.huawei.hmos.aidispatchservice",
        needUnlock: true,
        actionResponse: true,
        appType: "OHOS_APP",
        timeOut: 5,
        intentParam: {
          query: query,
        },
        permissionId: [],
        achieveType: "INTENT",
      },
      responses: [
        {
          resultCode: "",
          displayText: "",
          ttsText: "",
        },
      ],
      needUploadResult: true,
      noHalfPage: false,
      pageControlRelated: false,
    },
  };

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      logger.error(`[SEARCH_PHOTO_TOOL] ⏰ Timeout: No response for SearchPhotoVideo within 60 seconds`);
      wsManager.off("data-event", handler);
      reject(new Error("搜索照片超时（60秒）"));
    }, 60000);

    const handler = (event: A2ADataEvent) => {
      logger.log(`[SEARCH_PHOTO_TOOL] 📨 Received data event (Step 1):`, JSON.stringify(event));

      if (event.intentName === "SearchPhotoVideo") {
        logger.log(`[SEARCH_PHOTO_TOOL] 🎯 SearchPhotoVideo event received`);
        logger.log(`[SEARCH_PHOTO_TOOL]   - status: ${event.status}`);

        clearTimeout(timeout);
        wsManager.off("data-event", handler);

        if (event.status === "success" && event.outputs) {
          logger.log(`[SEARCH_PHOTO_TOOL] ✅ Photo search completed successfully`);

          const result = event.outputs.result;
          const items = result?.items || [];

          // Extract mediaUri from each item
          const mediaUris = items.map((item: any) => item.mediaUri).filter(Boolean);

          logger.log(`[SEARCH_PHOTO_TOOL] 📊 Extracted ${mediaUris.length} mediaUris`);
          resolve(mediaUris);
        } else {
          logger.error(`[SEARCH_PHOTO_TOOL] ❌ Photo search failed`);
          logger.error(`[SEARCH_PHOTO_TOOL]   - status: ${event.status}`);
          reject(new Error(`搜索照片失败: ${event.status}`));
        }
      }
    };

    logger.log(`[SEARCH_PHOTO_TOOL] 📡 Registering data-event handler for SearchPhotoVideo`);
    wsManager.on("data-event", handler);

    logger.log(`[SEARCH_PHOTO_TOOL] 📤 Sending SearchPhotoVideo command...`);
    sendCommand({
      config,
      sessionId,
      taskId,
      messageId,
      command,
    })
      .then(() => {
        logger.log(`[SEARCH_PHOTO_TOOL] ✅ SearchPhotoVideo command sent successfully`);
      })
      .catch((error) => {
        logger.error(`[SEARCH_PHOTO_TOOL] ❌ Failed to send SearchPhotoVideo command:`, error);
        clearTimeout(timeout);
        wsManager.off("data-event", handler);
        reject(error);
      });
  });
}

/**
 * Step 2: Get public URLs for photos using mediaUris
 * Returns array of publicly accessible image URLs
 */
async function getPhotoUrls(
  wsManager: any,
  config: any,
  sessionId: string,
  taskId: string,
  messageId: string,
  mediaUris: string[]
): Promise<string[]> {
  logger.log(`[SEARCH_PHOTO_TOOL] 📦 Building ImageUploadForClaw command...`);

  // Build imageInfos array from mediaUris
  const imageInfos = mediaUris.map(mediaUri => ({ mediaUri }));

  const command = {
    header: {
      namespace: "Common",
      name: "Action",
    },
    payload: {
      cardParam: {},
      executeParam: {
        executeMode: "background",
        intentName: "ImageUploadForClaw",
        bundleName: "com.huawei.hmos.vassistant",
        needUnlock: true,
        actionResponse: true,
        appType: "OHOS_APP",
        timeOut: 5,
        intentParam: {
          imageInfos: imageInfos,
        },
        permissionId: [],
        achieveType: "INTENT",
      },
      responses: [
        {
          resultCode: "",
          displayText: "",
          ttsText: "",
        },
      ],
      needUploadResult: true,
      noHalfPage: false,
      pageControlRelated: false,
    },
  };

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      logger.error(`[SEARCH_PHOTO_TOOL] ⏰ Timeout: No response for ImageUploadForClaw within 60 seconds`);
      wsManager.off("data-event", handler);
      reject(new Error("获取照片URL超时（60秒）"));
    }, 60000);

    const handler = (event: A2ADataEvent) => {
      logger.log(`[SEARCH_PHOTO_TOOL] 📨 Received data event (Step 2):`, JSON.stringify(event));

      if (event.intentName === "ImageUploadForClaw") {
        logger.log(`[SEARCH_PHOTO_TOOL] 🎯 ImageUploadForClaw event received`);
        logger.log(`[SEARCH_PHOTO_TOOL]   - status: ${event.status}`);

        clearTimeout(timeout);
        wsManager.off("data-event", handler);

        if (event.status === "success" && event.outputs) {
          logger.log(`[SEARCH_PHOTO_TOOL] ✅ Image URL retrieval completed successfully`);

          const result = event.outputs.result;
          let imageUrls = result?.imageUrls || [];

          // Decode Unicode escape sequences in URLs
          // Replace \u003d with = and \u0026 with &
          imageUrls = imageUrls.map((url: string) => {
            const decodedUrl = url
              .replace(/\\u003d/g, '=')
              .replace(/\\u0026/g, '&');
            logger.log(`[SEARCH_PHOTO_TOOL] 🔄 Decoded URL: ${url} -> ${decodedUrl}`);
            return decodedUrl;
          });

          logger.log(`[SEARCH_PHOTO_TOOL] 📊 Retrieved and decoded ${imageUrls.length} image URLs`);
          resolve(imageUrls);
        } else {
          logger.error(`[SEARCH_PHOTO_TOOL] ❌ Image URL retrieval failed`);
          logger.error(`[SEARCH_PHOTO_TOOL]   - status: ${event.status}`);
          reject(new Error(`获取照片URL失败: ${event.status}`));
        }
      }
    };

    logger.log(`[SEARCH_PHOTO_TOOL] 📡 Registering data-event handler for ImageUploadForClaw`);
    wsManager.on("data-event", handler);

    logger.log(`[SEARCH_PHOTO_TOOL] 📤 Sending ImageUploadForClaw command...`);
    sendCommand({
      config,
      sessionId,
      taskId,
      messageId,
      command,
    })
      .then(() => {
        logger.log(`[SEARCH_PHOTO_TOOL] ✅ ImageUploadForClaw command sent successfully`);
      })
      .catch((error) => {
        logger.error(`[SEARCH_PHOTO_TOOL] ❌ Failed to send ImageUploadForClaw command:`, error);
        clearTimeout(timeout);
        wsManager.off("data-event", handler);
        reject(error);
      });
  });
}

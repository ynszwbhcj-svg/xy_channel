// Upload Photo tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY upload photo tool - uploads local photos to get publicly accessible URLs.
 * Requires mediaUris from search_photo_gallery tool as prerequisite.
 *
 * Prerequisites:
 * 1. Call search_photo_gallery tool first to get mediaUris of photos
 * 2. Use the mediaUris (maximum 5 at a time) to get public URLs
 */
export function createUploadPhotoTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "upload_photo",
  label: "Upload Photo",
  description: `工具能力描述：将用户本地设备文件回传并获取可公网访问的 URL。

  前置工具调用：此工具使用前必须先通过call_device_tool工具调用 search_photo_gallery 工具获取照片的 mediaUri或者thumbnailUri
  工具参数说明：
  a. 入参中的mediaUris中的mediaUri必须与search_photo_gallery结果中对应的mediaUri或者thumbnailUri完全保持一致，不要自行修改，必须是file:://开头的路径。
  b. 优先使用search_photo_gallery结果中的thumbnailUri作为入参，thumbnailUri是缩略图，清晰度与文件大小都非常合适展示给用户，如果thumbnailUri不存在或者用户要求使用原图，则使用search_photo_gallery结果中对应的mediaUri
  c. mediaUris 是照片在手机本地的 URI 数组（从 search_photo_gallery 工具响应中获取）。限制：每次最多支持传入 3 条 mediaUri。

  注意事项：
  a. 操作超时时间为60秒,请勿重复调用此工具,如果超时或失败,最多重试一次。
  b. 此工具返回的图片链接为用户公网可访问的链接，如果需要后续操作需要下载到本地，如果需要返回给用户查看则直接以图片markdown的形式返回给用户`,
  parameters: {
    type: "object",
    properties: {
      mediaUris: {
        // 不指定 type，允许传入数组或 JSON 字符串
        // 具体的类型验证和转换在 execute 函数内部进行
        description: "照片在手机本地的 URI 数组，必须先通过 search_photo_gallery 工具获取。每次最多支持 3 条 URI。",
      },
    },
    required: ["mediaUris"],
  },

  async execute(toolCallId: string, params: any) {

    // ===== 参数规范化：兼容数组和 JSON 字符串 =====
    let mediaUris: string[] | null = null;

    if (!params.mediaUris) {
      throw new Error("Missing required parameter: mediaUris");
    }

    // 情况1: 已经是数组
    if (Array.isArray(params.mediaUris)) {
      mediaUris = params.mediaUris;
    }
    // 情况2: 是字符串，尝试解析为 JSON 数组
    else if (typeof params.mediaUris === 'string') {
      try {
        const parsed = JSON.parse(params.mediaUris);
        if (Array.isArray(parsed)) {
          mediaUris = parsed;
        } else {
          throw new Error("mediaUris must be an array or a JSON string representing an array");
        }
      } catch (parseError) {
        throw new Error(`mediaUris must be a valid JSON array string. Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      }
    }
    // 情况3: 其他类型，报错
    else {
      throw new Error(`mediaUris must be an array or a JSON string, got ${typeof params.mediaUris}`);
    }

    // 验证数组非空
    if (!mediaUris || mediaUris.length === 0) {
      throw new Error("mediaUris array cannot be empty");
    }


    // Validate maximum 5 URIs
    if (mediaUris.length > 5) {
      throw new Error(`最多支持 5 条 mediaUri，当前提供了 ${mediaUris.length} 条。请分批处理。`);
    }


    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Get public URLs for the photos
    const imageUrls = await getPhotoUrls(wsManager, config, sessionId, taskId, messageId, mediaUris);


    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            imageUrls,
            count: imageUrls.length,
            message: `成功获取 ${imageUrls.length} 张照片的公网访问 URL`
          }),
        },
      ],
    };
  },
};
}

/**
 * Get public URLs for photos using mediaUris
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
      wsManager.off("data-event", handler);
      reject(new Error("获取照片URL超时（60秒）"));
    }, 60000);

    const handler = (event: A2ADataEvent) => {

      if (event.intentName === "ImageUploadForClaw") {

        clearTimeout(timeout);
        wsManager.off("data-event", handler);

        if (event.status === "success" && event.outputs) {

          const result = event.outputs.result;
          let imageUrls = result?.imageUrls || [];

          // Decode Unicode escape sequences in URLs
          // Replace \u003d with = and \u0026 with &
          imageUrls = imageUrls.map((url: string) => {
            const decodedUrl = url
              .replace(/\\u003d/g, '=')
              .replace(/\\u0026/g, '&');
            return decodedUrl;
          });

          resolve(imageUrls);
        } else {
          reject(new Error(`获取照片URL失败: ${event.status}`));
        }
      }
    };

    wsManager.on("data-event", handler);

    sendCommand({
      config,
      sessionId,
      taskId,
      messageId,
      command,
    })
      .then(() => {
      })
      .catch((error) => {
        clearTimeout(timeout);
        wsManager.off("data-event", handler);
        reject(error);
      });
  });
}

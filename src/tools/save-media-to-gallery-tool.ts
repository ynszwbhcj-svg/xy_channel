// Save Media to Gallery tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";
import { XYFileUploadService } from "../file-upload.js";

/**
 * Duck-typed ToolInputError: openclaw 按 .name 字段匹配，不用 instanceof。
 * 抛出此错误会让 openclaw 返回 HTTP 400 而非 500，
 * LLM 会将其识别为参数错误而非瞬时故障，不会触发重试。
 */
class ToolInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/**
 * XY save media to gallery tool - saves image or video files to user's device gallery.
 * Supports local file paths (auto-uploaded to get public URL) and public URLs.
 */
export function createSaveMediaToGalleryTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "save_media_to_gallery",
  label: "Save Media to Gallery",
  description: `将图片文件或者视频文件保存到设备图库。

  注意:
  a. 操作超时时间为60秒,请勿重复调用此工具
  b. 如果遇到各类调用失败场景,最多只能重试一次，不可以重复调用多次。
  c. 调用工具前需认真检查调用参数是否满足工具要求

  回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。
  `,
  parameters: {
    type: "object",
    properties: {
      mediaType: {
        type: "string",
        description: "非必填，不传默认为pic。支持 pic(图片) 或 video(视频)。",
      },
      fileName: {
        type: "string",
        description: "非必填，文件名称，不传手机侧默认生成随机uuid。",
      },
      url: {
        type: "string",
        description: "必填，支持本地路径或者公网url路径。如果是本地路径，会先上传获取公网url再保存到图库",
      },
    },
    required: ["url"],
  },

  async execute(toolCallId: string, params: any) {

    // Validate parameters
    const { mediaType, fileName, url } = params;

    if (!url || typeof url !== "string") {
      throw new ToolInputError("缺少必填参数: url");
    }

    if (mediaType && !["pic", "video"].includes(mediaType)) {
      throw new ToolInputError(`mediaType只支持 pic 或 video，当前值: ${mediaType}`);
    }

    // Strip file extension from fileName if present
    let sanitizedFileName = fileName;
    if (sanitizedFileName && typeof sanitizedFileName === "string") {
      const lastDot = sanitizedFileName.lastIndexOf(".");
      if (lastDot > 0) {
        sanitizedFileName = sanitizedFileName.substring(0, lastDot);
      }
    }

    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Determine the URL: if it's a local path, upload first to get public URL
    let publicUrl = url;

    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      // Local file path - upload to get public URL
      const uploadService = new XYFileUploadService(
        config.fileUploadUrl,
        config.apiKey,
        config.uid
      );
      publicUrl = await uploadService.uploadFileAndGetUrl(url);

      if (!publicUrl) {
        throw new Error("本地文件上传失败，无法获取公网URL");
      }
    }

    // Build intentParam
    const intentParam: Record<string, string> = {
      url: publicUrl,
    };
    if (mediaType) {
      intentParam.mediaType = mediaType;
    }
    if (sanitizedFileName) {
      intentParam.fileName = sanitizedFileName;
    }

    // Build SaveMediaToGallery command
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "SaveMediaToGallery",
          bundleName: "com.huawei.hmos.vassistant",
          dimension: "",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam,
          permissionId: ["ohos.permission.WRITE_IMAGEVIDEO"],
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

    // Send command and wait for response (60 second timeout)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        wsManager.off("data-event", handler);
        reject(new Error("保存媒体到图库超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {

        if (event.intentName === "SaveMediaToGallery") {

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {

            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(event.outputs),
                }
              ]
            });
          } else {
            reject(new Error(`保存媒体到图库失败: ${event.status}`));
          }
        }
      };

      // Register event handler
      wsManager.on("data-event", handler);

      // Send the command
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
    },
  };
}

// Save File to Phone tool implementation
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
 * XY save file to phone tool - saves files to user's device file manager.
 * Supports local file paths (auto-uploaded to get public URL) and public URLs.
 */
export function createSaveFileToPhoneTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "save_file_to_file_manager",
  label: "Save File to Phone",
  description: `将文件保存到用户设备的文件管理器中，通常用户表述为'帮我保存到文管','保存到文件管理'。

  注意:
  a. 操作超时时间为60秒,请勿重复调用此工具
  b. 如果遇到各类调用失败场景,不可以重试，直接返回错误。
  c. 调用工具前需认真检查调用参数是否满足工具要求

  回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。
  `,
  parameters: {
    type: "object",
    properties: {
      fileName: {
        type: "string",
        description: "必填，文件名称。",
      },
      url: {
        type: "string",
        description: "必填，支持本地路径或者公网url路径。如果是本地路径会先上传获取公网url。",
      },
      suffix: {
        type: "string",
        description: "必填，文件后缀，例如 ppt、doc、pdf 等。",
      },
    },
    required: ["fileName", "url", "suffix"],
  },

  async execute(toolCallId: string, params: any) {

    // Validate parameters
    const { fileName, url, suffix } = params;

    if (!url || typeof url !== "string") {
      throw new ToolInputError("缺少必填参数: url");
    }

    if (!fileName || typeof fileName !== "string") {
      throw new ToolInputError("缺少必填参数: fileName");
    }

    if (!suffix || typeof suffix !== "string") {
      throw new ToolInputError("缺少必填参数: suffix");
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
      fileName: fileName,
      url: publicUrl,
      suffix: suffix,
    };

    // Build SaveFileToFileManager command
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "SaveFileToFileManager",
          bundleName: "com.huawei.hmos.vassistant",
          dimension: "",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          timeout: 55000,
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
        reject(new Error("保存文件到手机超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {

        if (event.intentName === "SaveFileToFileManager") {

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
            reject(new Error(`保存文件到手机失败: ${event.status}`));
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

// Search File tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY search file tool - searches files on user's device file system.
 * Returns matching files based on keyword search in file name or content.
 */
export function createSearchFileTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "search_file",
  label: "Search File",
  description: `搜索用户设备文件系统的文件。

【重要】使用约束：此工具仅在用户显著说明要从手机/PC等用户设备搜索时才执行，例如：
- "从我手机/鸿蒙PC里面搜索xxxx"
- "从手机文件系统找一下xxxx"
- "在手机上查找文件xxxx"
- "搜索手机里的文件"

如果用户没有明确说明从手机或者PC搜索（如仅说"搜索文件"、"找一下xxxx"），应默认从当前runtime运行环境的本地的文件系统查询，不要调用此工具。

功能说明：根据关键词搜索文件名称或内容，返回匹配的文件列表（包括文件名、路径、大小、修改时间等信息）。

注意事项：操作超时时间为60秒，请勿重复调用此工具，如果超时或失败，最多重试一次。`,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "搜索关键词，用于匹配文件名称、后缀名或文件内容",
      },
    },
    required: ["query"],
  },

  async execute(toolCallId: string, params: any) {

    // Validate query parameter
    if (!params.query || typeof params.query !== "string" || params.query.trim() === "") {
      throw new Error("Missing required parameter: query must be a non-empty string");
    }


    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build SearchFile command
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "SearchFile",
          bundleName: "com.huawei.hmos.aidispatchservice",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam: {
            query: params.query.trim(),
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


    // Send command and wait for response (60 second timeout)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        wsManager.off("data-event", handler);
        reject(new Error("搜索文件超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {

        if (event.intentName === "SearchFile") {

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {

            // 成功，直接返回完整的 event.outputs JSON 字符串
            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(event.outputs),
                }
              ]
            });
          } else {

            const errorDetail = event.outputs ? JSON.stringify(event.outputs) : event.status;
            reject(new Error(`搜索文件失败: ${errorDetail}`));
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

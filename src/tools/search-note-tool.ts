// Search Note tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY search note tool - searches notes on user's device.
 * Returns matching notes based on query string.
 */
export function createSearchNoteTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "search_notes",
  label: "Search Notes",
  description: "搜索用户设备上的备忘录内容。根据关键词在备忘录的标题、内容和附件名称中进行检索。注意:操作超时时间为60秒,请勿重复调用此工具,如果超时或失败,最多重试一次。回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "搜索关键词，用于在备忘录中检索相关内容",
      },
    },
    required: ["query"],
  },

  async execute(toolCallId: string, params: any) {

    // Validate parameters
    if (!params.query) {
      throw new Error("Missing required parameter: query is required");
    }

    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build SearchNote command
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "SearchNote",
          bundleName: "com.huawei.hmos.notepad",
          dimension: "",
          needUnlock: true,
          actionResponse: true,
          timeOut: 5,
          intentParam: {
            query: params.query,
          },
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
        reject(new Error("搜索备忘录超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {

        if (event.intentName === "SearchNote") {

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {

            // 成功，直接返回完整的 event.outputs JSON 字符串
            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(event.outputs),
                },
              ],
            });
          } else {
            reject(new Error(`搜索备忘录失败: ${event.status}`));
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
      }).then(() => {
      }).catch((error) => {
        clearTimeout(timeout);
        wsManager.off("data-event", handler);
        reject(error);
      });
    });
  },
};
}

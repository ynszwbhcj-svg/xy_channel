// Search Message tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY search message tool - searches SMS messages on user's device.
 * Returns matching messages based on content keyword search.
 */
export function createSearchMessageTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "search_message",
  label: "Search Message",
  description: "搜索手机短信。根据关键词搜索短信内容。注意:操作超时时间为60秒,请勿重复调用此工具,如果超时或失败,最多重试一次。",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "搜索关键词，用于在短信内容中进行匹配",
      },
    },
    required: ["content"],
  },

  async execute(toolCallId: string, params: any) {

    // Validate content parameter
    if (!params.content || typeof params.content !== "string" || params.content.trim() === "") {
      throw new Error("Missing required parameter: content must be a non-empty string");
    }


    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build SearchMessage command
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "SearchMessage",
          bundleName: "com.huawei.hmos.aidispatchservice",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam: {
            content: params.content.trim(),
            size: 50
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
        reject(new Error("搜索短信超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {

        if (event.intentName === "SearchMessage") {

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

            const errorDetail = event.outputs ? JSON.stringify(event.outputs) : event.status;
            reject(new Error(`搜索短信失败: ${errorDetail}`));
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

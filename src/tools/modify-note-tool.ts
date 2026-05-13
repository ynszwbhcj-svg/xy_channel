// Modify Note tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY modify note tool - appends content to an existing note on user's device.
 * Requires entityId from search_notes tool as prerequisite.
 *
 * Prerequisites:
 * 1. Call search_notes tool first to get the entityId of target note
 * 2. Use the entityId to append content to that note
 */
export function createModifyNoteTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "modify_note",
  label: "Modify Note",
  description: "在指定备忘录中追加新内容。使用前必须先调用 search_notes 工具获取备忘录的 entityId。参数说明：entityId 是备忘录的唯一标识符（从 search_notes 工具获取），text 是要追加的文本内容。注意:操作超时时间为60秒,请勿重复调用此工具,如果超时或失败,最多重试一次。回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。",
  parameters: {
    type: "object",
    properties: {
      entityId: {
        type: "string",
        description: "备忘录的唯一标识符，必须先通过 search_notes 工具获取",
      },
      text: {
        type: "string",
        description: "要追加到备忘录的文本内容",
      },
    },
    required: ["entityId", "text"],
  },

  async execute(toolCallId: string, params: any) {

    // Validate parameters
    if (!params.entityId || !params.text) {
      throw new Error("Missing required parameters: entityId and text are required");
    }

    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build ModifyNote command
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "ModifyNote",
          bundleName: "com.huawei.hmos.notepad",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam: {
            contentType: "1", // 1 = append mode (追加模式)
            text: params.text,
            entityId: params.entityId,
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
        reject(new Error("修改备忘录超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {

        if (event.intentName === "ModifyNote") {

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
            reject(new Error(`修改备忘录失败: ${event.status}`));
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

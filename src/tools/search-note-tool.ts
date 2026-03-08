// Search Note tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getLatestSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY search note tool - searches notes on user's device.
 * Returns matching notes based on query string.
 */
export const searchNoteTool: any = {
  name: "search_notes",
  label: "Search Notes",
  description: "搜索用户设备上的备忘录内容。根据关键词在备忘录的标题、内容和附件名称中进行检索。",
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
    logger.debug("Executing search note tool, toolCallId:", toolCallId);

    // Validate parameters
    if (!params.query) {
      throw new Error("Missing required parameter: query is required");
    }

    // Get session context
    const sessionContext = getLatestSessionContext();
    if (!sessionContext) {
      throw new Error("No active XY session found. Search note tool can only be used during an active conversation.");
    }

    const { config, sessionId, taskId, messageId } = sessionContext;

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

    // Send command and wait for response (5 second timeout)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        wsManager.off("data-event", handler);
        reject(new Error("搜索备忘录超时（15秒）"));
      }, 15000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {
        logger.debug("Received data event:", event);

        if (event.intentName === "SearchNote") {
          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {
            const { result, code } = event.outputs;
            const items = result?.items || [];

            logger.log(`Notes found: ${items.length} results for query "${params.query}"`);

            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: true,
                    query: params.query,
                    totalResults: items.length,
                    notes: items.map((item: any) => ({
                      entityId: item.entityId,
                      entityName: item.entityName,
                      title: item.title?.replace(/<\/?em>/g, ''), // Remove <em> tags
                      content: item.content,
                      createdDate: item.createdDate,
                      modifiedDate: item.modifiedDate,
                    })),
                    indexName: result?.indexName,
                    code,
                  }),
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
      }).catch((error) => {
        clearTimeout(timeout);
        wsManager.off("data-event", handler);
        reject(error);
      });
    });
  },
};

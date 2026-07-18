// Search File tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getCachedXYWebSocketManager } from "../transport/client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { getCurrentSessionContext } from './session-manager.js';

import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY search file tool - searches files on user's device file system.
 * Returns matching files based on keyword search in file name or content.
 */
export const searchFileTool = {
  name: "search_file",
  label: "Search File",
  description: `搜索用户设备的文件系统的文件，用户设备可以是手机或者鸿蒙PC等。

使用场景与调用流程：
当用户明确说明要从设备搜索时（如"从手机里面搜索xxxx"、"在手机上查找文件xxxx"，"查找我电脑上的xxxx文件"，"查找我鸿蒙PC上的xxx文件"），直接调用此工具。

如果用户没有明确说明从设备搜索（如仅说"搜索文件"、"找一下xxxx"），应默认从当前runtime运行环境的本地文件系统查询，不要调用此工具。

功能说明：根据关键词搜索文件名称或内容，返回匹配的文件列表（包括文件名、路径、大小、修改时间等信息）。

注意事项：操作超时时间为60秒，请勿重复调用此工具，如果超时或失败，最多重试一次。`,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "搜索关键词，用于匹配文件名称、后缀名或文件内容",
      }
    },
    required: ["query"],
  },

  async execute(toolCallId: string, params: any) {

    const _c = getCurrentSessionContext();

    const { config, sessionId, taskId, messageId } = _c;
// Validate query parameter
    if (!params.query || typeof params.query !== "string" || params.query.trim() === "") {
      throw new Error("Missing required parameter: query must be a non-empty string");
    }


    // Get WebSocket manager
    const wsManager = getCachedXYWebSocketManager();

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
            ...(params.udid ? { udid: params.udid } : {}),
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
        logger.error("超时: 搜索文件超时（60秒）", { toolCallId });
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
        toolCallId,
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

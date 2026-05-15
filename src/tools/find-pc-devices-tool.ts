// Find PC devices tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY find PC devices tool - finds all PC devices associated with the user.
 * Returns device IDs for use in subsequent file search operations.
 */
export function createFindPcDevicesTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "find_pc_devices",
  label: "Find PC Devices",
  description: `查找用户所有PC/电脑设备，获取设备ID列表。当用户说"帮我找一下PC/电脑上的xxx文件"、"帮我搜索电脑上的xxx"等涉及PC设备的请求时，先调用此工具获取设备ID，再进行后续操作。注意:操作超时时间为60秒,请勿重复调用此工具,如果超时或失败,最多重试一次。回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，请严格遵守。`,
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },

  async execute(toolCallId: string, params: any) {

    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build GetAllDevice command
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          achieveType: "INTENT",
          actionResponse: true,
          bundleName: "com.huawei.hmos.aidispatchservice",
          dimension: "",
          executeMode: "background",
          intentName: "GetAllDevice",
          intentParam: {},
          needUnlock: true,
          permissionId: [],
          timeOut: 5,
        },
        needUploadResult: true,
        pageControlRelated: false,
        responses: [{
          displayText: "",
          resultCode: "",
          ttsText: "",
        }],
      },
    };

    // Send command and wait for response (60 second timeout)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        wsManager.off("data-event", handler);
        reject(new Error("查找PC设备超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {
        if (event.intentName === "GetAllDevice") {
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
            reject(new Error(`查找PC设备失败: ${event.status}`));
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

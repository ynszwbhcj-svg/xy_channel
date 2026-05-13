// Location tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY location tool - gets user's current location.
 * Returns WGS84 coordinates (latitude, longitude).
 */
export function createLocationTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "get_user_location",
  label: "Get User Location",
  description: "获取用户当前位置（经纬度坐标，WGS84坐标系）。需要用户设备授权位置访问权限。注意:操作超时时间为60秒,请勿重复调用此工具,如果超时或失败,最多重试一次。回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },

  async execute(toolCallId: string, params: any) {

    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build GetCurrentLocation command
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
          intentName: "GetCurrentLocation",
          intentParam: {
            isNeedGeoAddress: true,
          },
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
        reject(new Error("获取位置超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {

        if (event.intentName === "GetCurrentLocation") {

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
            reject(new Error(`获取位置失败: ${event.status}`));
          }
        }
      };

      // Register event handler
      // Note: The WebSocket manager needs to emit 'data-event' when receiving data events
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

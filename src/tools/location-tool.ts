// Location tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getLatestSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY location tool - gets user's current location.
 * Returns WGS84 coordinates (latitude, longitude).
 */
export const locationTool: any = {
  name: "get_user_location",
  label: "Get User Location",
  description: "获取用户当前位置（经纬度坐标，WGS84坐标系）。需要用户设备授权位置访问权限。",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },

  async execute(toolCallId: string, params: any) {
    logger.debug("Executing location tool, toolCallId:", toolCallId);

    // Get session context
    const sessionContext = getLatestSessionContext();
    if (!sessionContext) {
      throw new Error("No active XY session found. Location tool can only be used during an active conversation.");
    }

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build GetCurrentLocation command
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        executeParam: {
          achieveType: "INTENT",
          actionResponse: true,
          bundleName: "com.huawei.hmos.aidispatchservice",
          intentName: "GetCurrentLocation",
          intentParam: {},
          needUnlock: true,
          timeOut: 5,
        },
        needUploadResult: true,
      },
    };

    // Send command and wait for response (5 second timeout)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        wsManager.off("data-event", handler);
        reject(new Error("获取位置超时（5秒）"));
      }, 5000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {
        logger.debug("Received data event:", event);

        if (event.intentName === "GetCurrentLocation") {
          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {
            const { latitude, longitude } = event.outputs;
            logger.log(`Location retrieved: lat=${latitude}, lon=${longitude}`);
            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    latitude,
                    longitude,
                    coordinateSystem: "WGS84",
                  })
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
      }).catch((error) => {
        clearTimeout(timeout);
        wsManager.off("data-event", handler);
        reject(error);
      });
    });
  },
};

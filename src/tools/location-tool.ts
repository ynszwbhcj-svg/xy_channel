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
    logger.log(`[LOCATION_TOOL] 🚀 Starting execution`);
    logger.log(`[LOCATION_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[LOCATION_TOOL]   - params:`, JSON.stringify(params));
    logger.log(`[LOCATION_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // Get session context
    logger.log(`[LOCATION_TOOL] 🔍 Attempting to get session context...`);
    const sessionContext = getLatestSessionContext();

    if (!sessionContext) {
      logger.error(`[LOCATION_TOOL] ❌ FAILED: No active session found!`);
      logger.error(`[LOCATION_TOOL]   - toolCallId: ${toolCallId}`);
      logger.error(`[LOCATION_TOOL]   - This suggests the session was not registered or already cleaned up`);
      throw new Error("No active XY session found. Location tool can only be used during an active conversation.");
    }

    logger.log(`[LOCATION_TOOL] ✅ Session context found`);
    logger.log(`[LOCATION_TOOL]   - sessionId: ${sessionContext.sessionId}`);
    logger.log(`[LOCATION_TOOL]   - taskId: ${sessionContext.taskId}`);
    logger.log(`[LOCATION_TOOL]   - messageId: ${sessionContext.messageId}`);
    logger.log(`[LOCATION_TOOL]   - agentId: ${sessionContext.agentId}`);

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    logger.log(`[LOCATION_TOOL] 🔌 Getting WebSocket manager...`);
    const wsManager = getXYWebSocketManager(config);
    logger.log(`[LOCATION_TOOL] ✅ WebSocket manager obtained`);

    // Build GetCurrentLocation command
    logger.log(`[LOCATION_TOOL] 📦 Building GetCurrentLocation command...`);
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

    // Send command and wait for response (5 second timeout)
    logger.log(`[LOCATION_TOOL] ⏳ Setting up promise to wait for location response...`);
    logger.log(`[LOCATION_TOOL]   - Timeout: 5 seconds`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.error(`[LOCATION_TOOL] ⏰ Timeout: No response received within 5 seconds`);
        wsManager.off("data-event", handler);
        reject(new Error("获取位置超时（5秒）"));
      }, 5000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {
        logger.log(`[LOCATION_TOOL] 📨 Received data event:`, JSON.stringify(event));

        if (event.intentName === "GetCurrentLocation") {
          logger.log(`[LOCATION_TOOL] 🎯 GetCurrentLocation event received`);
          logger.log(`[LOCATION_TOOL]   - status: ${event.status}`);

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {
            const { latitude, longitude } = event.outputs;
            logger.log(`[LOCATION_TOOL] ✅ Location retrieved successfully`);
            logger.log(`[LOCATION_TOOL]   - latitude: ${latitude}`);
            logger.log(`[LOCATION_TOOL]   - longitude: ${longitude}`);

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
            logger.error(`[LOCATION_TOOL] ❌ Location retrieval failed`);
            logger.error(`[LOCATION_TOOL]   - status: ${event.status}`);
            reject(new Error(`获取位置失败: ${event.status}`));
          }
        }
      };

      // Register event handler
      // Note: The WebSocket manager needs to emit 'data-event' when receiving data events
      logger.log(`[LOCATION_TOOL] 📡 Registering data-event handler on WebSocket manager`);
      wsManager.on("data-event", handler);

      // Send the command
      logger.log(`[LOCATION_TOOL] 📤 Sending GetCurrentLocation command...`);
      sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
      }).then(() => {
        logger.log(`[LOCATION_TOOL] ✅ Command sent successfully, waiting for response...`);
      }).catch((error) => {
        logger.error(`[LOCATION_TOOL] ❌ Failed to send command:`, error);
        clearTimeout(timeout);
        wsManager.off("data-event", handler);
        reject(error);
      });
    });
  },
};

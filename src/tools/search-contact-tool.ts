// Search Contact Local tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getLatestSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY search contact tool - searches contacts on user's device.
 * Returns matching contact information based on name.
 */
export const searchContactTool: any = {
  name: "search_contact",
  label: "Search Contact",
  description: "搜索用户设备上的联系人信息。根据姓名在通讯录中检索联系人详细信息（包括姓名、电话号码、邮箱、组织、职位等）。注意:操作超时时间为60秒,请勿重复调用此工具,如果超时或失败,最多重试一次。",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "联系人姓名，用于在通讯录中检索联系人信息",
      },
    },
    required: ["name"],
  },

  async execute(toolCallId: string, params: any) {
    logger.log(`[SEARCH_CONTACT_TOOL] 🚀 Starting execution`);
    logger.log(`[SEARCH_CONTACT_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[SEARCH_CONTACT_TOOL]   - params:`, JSON.stringify(params));
    logger.log(`[SEARCH_CONTACT_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // Validate parameters
    if (!params.name) {
      logger.error(`[SEARCH_CONTACT_TOOL] ❌ Missing required parameter: name`);
      throw new Error("Missing required parameter: name is required");
    }

    // Get session context
    logger.log(`[SEARCH_CONTACT_TOOL] 🔍 Attempting to get session context...`);
    const sessionContext = getLatestSessionContext();

    if (!sessionContext) {
      logger.error(`[SEARCH_CONTACT_TOOL] ❌ FAILED: No active session found!`);
      logger.error(`[SEARCH_CONTACT_TOOL]   - toolCallId: ${toolCallId}`);
      throw new Error("No active XY session found. Search contact tool can only be used during an active conversation.");
    }

    logger.log(`[SEARCH_CONTACT_TOOL] ✅ Session context found`);
    logger.log(`[SEARCH_CONTACT_TOOL]   - sessionId: ${sessionContext.sessionId}`);
    logger.log(`[SEARCH_CONTACT_TOOL]   - taskId: ${sessionContext.taskId}`);
    logger.log(`[SEARCH_CONTACT_TOOL]   - messageId: ${sessionContext.messageId}`);

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    logger.log(`[SEARCH_CONTACT_TOOL] 🔌 Getting WebSocket manager...`);
    const wsManager = getXYWebSocketManager(config);
    logger.log(`[SEARCH_CONTACT_TOOL] ✅ WebSocket manager obtained`);

    // Build SearchContactLocal command
    logger.log(`[SEARCH_CONTACT_TOOL] 📦 Building SearchContactLocal command...`);
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "SearchContactLocal",
          bundleName: "com.huawei.hmos.aidispatchservice",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam: {
            name: params.name,
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
    logger.log(`[SEARCH_CONTACT_TOOL] ⏳ Setting up promise to wait for contact search response...`);
    logger.log(`[SEARCH_CONTACT_TOOL]   - Timeout: 60 seconds`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.error(`[SEARCH_CONTACT_TOOL] ⏰ Timeout: No response received within 60 seconds`);
        wsManager.off("data-event", handler);
        reject(new Error("搜索联系人超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {
        logger.log(`[SEARCH_CONTACT_TOOL] 📨 Received data event:`, JSON.stringify(event));

        if (event.intentName === "SearchContactLocal") {
          logger.log(`[SEARCH_CONTACT_TOOL] 🎯 SearchContactLocal event received`);
          logger.log(`[SEARCH_CONTACT_TOOL]   - status: ${event.status}`);

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {
            logger.log(`[SEARCH_CONTACT_TOOL] ✅ Contact search completed successfully`);
            logger.log(`[SEARCH_CONTACT_TOOL]   - outputs:`, JSON.stringify(event.outputs));

            // Return the result directly as requested
            const result = event.outputs.result;

            logger.log(`[SEARCH_CONTACT_TOOL] 📊 Contacts found: ${result?.items?.length || 0} results for name "${params.name}"`);

            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result),
                },
              ],
            });
          } else {
            logger.error(`[SEARCH_CONTACT_TOOL] ❌ Contact search failed`);
            logger.error(`[SEARCH_CONTACT_TOOL]   - status: ${event.status}`);
            reject(new Error(`搜索联系人失败: ${event.status}`));
          }
        }
      };

      // Register event handler
      logger.log(`[SEARCH_CONTACT_TOOL] 📡 Registering data-event handler on WebSocket manager`);
      wsManager.on("data-event", handler);

      // Send the command
      logger.log(`[SEARCH_CONTACT_TOOL] 📤 Sending SearchContactLocal command...`);
      sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
      })
        .then(() => {
          logger.log(`[SEARCH_CONTACT_TOOL] ✅ Command sent successfully, waiting for response...`);
        })
        .catch((error) => {
          logger.error(`[SEARCH_CONTACT_TOOL] ❌ Failed to send command:`, error);
          clearTimeout(timeout);
          wsManager.off("data-event", handler);
          reject(error);
        });
    });
  },
};

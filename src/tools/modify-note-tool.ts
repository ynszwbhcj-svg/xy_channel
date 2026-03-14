// Modify Note tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getLatestSessionContext } from "./session-manager.js";
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
export const modifyNoteTool: any = {
  name: "modify_note",
  label: "Modify Note",
  description: "在指定备忘录中追加新内容。使用前必须先调用 search_notes 工具获取备忘录的 entityId。参数说明：entityId 是备忘录的唯一标识符（从 search_notes 工具获取），text 是要追加的文本内容。注意:操作超时时间为60秒,请勿重复调用此工具,如果超时或失败,最多重试一次。",
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
    logger.log(`[MODIFY_NOTE_TOOL] 🚀 Starting execution`);
    logger.log(`[MODIFY_NOTE_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[MODIFY_NOTE_TOOL]   - params:`, JSON.stringify(params));
    logger.log(`[MODIFY_NOTE_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // Validate parameters
    if (!params.entityId || !params.text) {
      logger.error(`[MODIFY_NOTE_TOOL] ❌ Missing required parameters`);
      throw new Error("Missing required parameters: entityId and text are required");
    }

    // Get session context
    logger.log(`[MODIFY_NOTE_TOOL] 🔍 Attempting to get session context...`);
    const sessionContext = getLatestSessionContext();

    if (!sessionContext) {
      logger.error(`[MODIFY_NOTE_TOOL] ❌ FAILED: No active session found!`);
      logger.error(`[MODIFY_NOTE_TOOL]   - toolCallId: ${toolCallId}`);
      throw new Error("No active XY session found. Modify note tool can only be used during an active conversation.");
    }

    logger.log(`[MODIFY_NOTE_TOOL] ✅ Session context found`);
    logger.log(`[MODIFY_NOTE_TOOL]   - sessionId: ${sessionContext.sessionId}`);
    logger.log(`[MODIFY_NOTE_TOOL]   - taskId: ${sessionContext.taskId}`);
    logger.log(`[MODIFY_NOTE_TOOL]   - messageId: ${sessionContext.messageId}`);

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    logger.log(`[MODIFY_NOTE_TOOL] 🔌 Getting WebSocket manager...`);
    const wsManager = getXYWebSocketManager(config);
    logger.log(`[MODIFY_NOTE_TOOL] ✅ WebSocket manager obtained`);

    // Build ModifyNote command
    logger.log(`[MODIFY_NOTE_TOOL] 📦 Building ModifyNote command...`);
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

    logger.log(`[MODIFY_NOTE_TOOL]   - entityId: ${params.entityId}`);
    logger.log(`[MODIFY_NOTE_TOOL]   - contentType: 1 (append mode)`);
    logger.log(`[MODIFY_NOTE_TOOL]   - text length: ${params.text.length} characters`);

    // Send command and wait for response (60 second timeout)
    logger.log(`[MODIFY_NOTE_TOOL] ⏳ Setting up promise to wait for note modification response...`);
    logger.log(`[MODIFY_NOTE_TOOL]   - Timeout: 60 seconds`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.error(`[MODIFY_NOTE_TOOL] ⏰ Timeout: No response received within 60 seconds`);
        wsManager.off("data-event", handler);
        reject(new Error("修改备忘录超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {
        logger.log(`[MODIFY_NOTE_TOOL] 📨 Received data event:`, JSON.stringify(event));

        if (event.intentName === "ModifyNote") {
          logger.log(`[MODIFY_NOTE_TOOL] 🎯 ModifyNote event received`);
          logger.log(`[MODIFY_NOTE_TOOL]   - status: ${event.status}`);

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {
            logger.log(`[MODIFY_NOTE_TOOL] ✅ Note modified successfully`);
            logger.log(`[MODIFY_NOTE_TOOL]   - outputs:`, JSON.stringify(event.outputs));

            // Return the result directly as requested
            const result = event.outputs.result;

            logger.log(`[MODIFY_NOTE_TOOL] 📝 Note updated:`);
            logger.log(`[MODIFY_NOTE_TOOL]   - entityId: ${result?.entityId}`);
            logger.log(`[MODIFY_NOTE_TOOL]   - title: ${result?.title}`);
            logger.log(`[MODIFY_NOTE_TOOL]   - modifiedDate: ${result?.modifiedDate}`);

            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result),
                },
              ],
            });
          } else {
            logger.error(`[MODIFY_NOTE_TOOL] ❌ Note modification failed`);
            logger.error(`[MODIFY_NOTE_TOOL]   - status: ${event.status}`);
            reject(new Error(`修改备忘录失败: ${event.status}`));
          }
        }
      };

      // Register event handler
      logger.log(`[MODIFY_NOTE_TOOL] 📡 Registering data-event handler on WebSocket manager`);
      wsManager.on("data-event", handler);

      // Send the command
      logger.log(`[MODIFY_NOTE_TOOL] 📤 Sending ModifyNote command...`);
      sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
      })
        .then(() => {
          logger.log(`[MODIFY_NOTE_TOOL] ✅ Command sent successfully, waiting for response...`);
        })
        .catch((error) => {
          logger.error(`[MODIFY_NOTE_TOOL] ❌ Failed to send command:`, error);
          clearTimeout(timeout);
          wsManager.off("data-event", handler);
          reject(error);
        });
    });
  },
};

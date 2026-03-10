// Calendar event tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getLatestSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY calendar event tool - creates a calendar event on user's device.
 * Requires title, dtStart (start time), and dtEnd (end time) parameters.
 * Time format must be: yyyy-mm-dd hh:mm:ss
 */
export const calendarTool: any = {
  name: "create_calendar_event",
  label: "Create Calendar Event",
  description: "在用户设备上创建日程。需要提供日程标题、开始时间和结束时间。时间格式必须为：yyyy-mm-dd hh:mm:ss（例如：2024-01-15 14:30:00）。注意：该工具执行时间较长（最多60秒），请勿重复调用，超时或失败时最多重试一次。",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "日程标题/名称",
      },
      dtStart: {
        type: "string",
        description: "日程开始时间，格式必须为：yyyy-mm-dd hh:mm:ss（例如：2024-01-15 14:30:00）",
      },
      dtEnd: {
        type: "string",
        description: "日程结束时间，格式必须为：yyyy-mm-dd hh:mm:ss（例如：2024-01-15 17:30:00）",
      },
    },
    required: ["title", "dtStart", "dtEnd"],
  },

  async execute(toolCallId: string, params: any) {
    logger.log(`[CALENDAR_TOOL] 🚀 Starting execution`);
    logger.log(`[CALENDAR_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[CALENDAR_TOOL]   - params:`, JSON.stringify(params));
    logger.log(`[CALENDAR_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // Validate parameters
    if (!params.title || !params.dtStart || !params.dtEnd) {
      logger.error(`[CALENDAR_TOOL] ❌ Missing required parameters`);
      throw new Error("Missing required parameters: title, dtStart, and dtEnd are required");
    }

    // Convert time strings to millisecond timestamps
    logger.log(`[CALENDAR_TOOL] 🕒 Converting time strings to timestamps...`);
    logger.log(`[CALENDAR_TOOL]   - dtStart input: ${params.dtStart}`);
    logger.log(`[CALENDAR_TOOL]   - dtEnd input: ${params.dtEnd}`);

    const dtStartMs = new Date(params.dtStart).getTime();
    const dtEndMs = new Date(params.dtEnd).getTime();

    if (isNaN(dtStartMs) || isNaN(dtEndMs)) {
      logger.error(`[CALENDAR_TOOL] ❌ Invalid time format`);
      throw new Error("Invalid time format. Required format: yyyy-mm-dd hh:mm:ss (e.g., 2024-01-15 14:30:00)");
    }

    logger.log(`[CALENDAR_TOOL] ✅ Time conversion successful`);
    logger.log(`[CALENDAR_TOOL]   - dtStart timestamp: ${dtStartMs}`);
    logger.log(`[CALENDAR_TOOL]   - dtEnd timestamp: ${dtEndMs}`);

    // Get session context
    logger.log(`[CALENDAR_TOOL] 🔍 Attempting to get session context...`);
    const sessionContext = getLatestSessionContext();

    if (!sessionContext) {
      logger.error(`[CALENDAR_TOOL] ❌ FAILED: No active session found!`);
      logger.error(`[CALENDAR_TOOL]   - toolCallId: ${toolCallId}`);
      throw new Error("No active XY session found. Calendar tool can only be used during an active conversation.");
    }

    logger.log(`[CALENDAR_TOOL] ✅ Session context found`);
    logger.log(`[CALENDAR_TOOL]   - sessionId: ${sessionContext.sessionId}`);
    logger.log(`[CALENDAR_TOOL]   - taskId: ${sessionContext.taskId}`);
    logger.log(`[CALENDAR_TOOL]   - messageId: ${sessionContext.messageId}`);

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    logger.log(`[CALENDAR_TOOL] 🔌 Getting WebSocket manager...`);
    const wsManager = getXYWebSocketManager(config);
    logger.log(`[CALENDAR_TOOL] ✅ WebSocket manager obtained`);

    // Build CreateCalendarEvent command
    logger.log(`[CALENDAR_TOOL] 📦 Building CreateCalendarEvent command...`);
    const command = {
      header: {
        namespace: "Common",
        name: "ActionAndResult",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "CreateCalendarEvent",
          bundleName: "com.huawei.hmos.calendardata",
          dimension: "",
          needUnlock: true,
          actionResponse: true,
          timeOut: 5,
          intentParam: {
            title: params.title,
            dtStart: dtStartMs,
            dtEnd: dtEndMs,
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

    // Send command and wait for response (60 second timeout)
    logger.log(`[CALENDAR_TOOL] ⏳ Setting up promise to wait for calendar event response...`);
    logger.log(`[CALENDAR_TOOL]   - Timeout: 60 seconds`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.error(`[CALENDAR_TOOL] ⏰ Timeout: No response received within 60 seconds`);
        wsManager.off("data-event", handler);
        reject(new Error("创建日程超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {
        logger.log(`[CALENDAR_TOOL] 📨 Received data event:`, JSON.stringify(event));

        if (event.intentName === "CreateCalendarEvent") {
          logger.log(`[CALENDAR_TOOL] 🎯 CreateCalendarEvent event received`);
          logger.log(`[CALENDAR_TOOL]   - status: ${event.status}`);

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {
            logger.log(`[CALENDAR_TOOL] ✅ Calendar event created successfully`);
            logger.log(`[CALENDAR_TOOL]   - outputs:`, JSON.stringify(event.outputs));

            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(event.outputs),
                },
              ],
            });
          } else {
            logger.error(`[CALENDAR_TOOL] ❌ Calendar event creation failed`);
            logger.error(`[CALENDAR_TOOL]   - status: ${event.status}`);
            reject(new Error(`创建日程失败: ${event.status}`));
          }
        }
      };

      // Register event handler
      logger.log(`[CALENDAR_TOOL] 📡 Registering data-event handler on WebSocket manager`);
      wsManager.on("data-event", handler);

      // Send the command
      logger.log(`[CALENDAR_TOOL] 📤 Sending CreateCalendarEvent command...`);
      sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
      })
        .then(() => {
          logger.log(`[CALENDAR_TOOL] ✅ Command sent successfully, waiting for response...`);
        })
        .catch((error) => {
          logger.error(`[CALENDAR_TOOL] ❌ Failed to send command:`, error);
          clearTimeout(timeout);
          wsManager.off("data-event", handler);
          reject(error);
        });
    });
  },
};

// Search Calendar Event tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getLatestSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY search calendar event tool - searches calendar events on user's device.
 * Returns matching events based on time range and optional title filter.
 *
 * Time range guidelines:
 * - For a specific day: use 00:00:00 to 23:59:59 of that day
 * - For morning: 06:00:00 to 12:00:00
 * - For afternoon: 12:00:00 to 18:00:00
 * - For evening: 18:00:00 to 24:00:00
 * - For a specific time: use ±1 hour range (e.g., for 3PM, use 14:00:00 to 16:00:00)
 */
export const searchCalendarTool: any = {
  name: "search_calendar_event",
  label: "Search Calendar Event",
  description: `检索用户日历中的日程安排。根据时间范围和可选的日程标题进行检索。时间格式必须为：YYYYMMDD hhmmss（例如：20240115 143000）。

时间范围说明：
- 查询某一天的日程：使用该天的 00:00:00 到 23:59:59（例如：20240115 000000 到 20240115 235959）
- 查询上午的日程：使用 06:00:00 到 12:00:00
- 查询下午的日程：使用 12:00:00 到 18:00:00
- 查询晚上的日程：使用 18:00:00 到 23:59:59
- 查询某个时刻附近的日程：使用该时刻前后1小时的区间（例如：查询3点左右的日程，使用 14:00:00 到 16:00:00）

注意：该工具执行时间较长（最多60秒），请勿重复调用，超时或失败时最多重试一次。`,
  parameters: {
    type: "object",
    properties: {
      startTime: {
        type: "string",
        description: "日程起始时间，格式必须为：YYYYMMDD hhmmss（例如：20240115 143000 表示 2024年1月15日 14:30:00）",
      },
      endTime: {
        type: "string",
        description: "日程结束时间，格式必须为：YYYYMMDD hhmmss（例如：20240115 173000 表示 2024年1月15日 17:30:00）",
      },
      title: {
        type: "string",
        description: "日程标题/类型（可选），用于过滤特定类型的日程",
      },
    },
    required: ["startTime", "endTime"],
  },

  async execute(toolCallId: string, params: any) {
    logger.log(`[SEARCH_CALENDAR_TOOL] 🚀 Starting execution`);
    logger.log(`[SEARCH_CALENDAR_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[SEARCH_CALENDAR_TOOL]   - params:`, JSON.stringify(params));
    logger.log(`[SEARCH_CALENDAR_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // Validate parameters
    if (!params.startTime || !params.endTime) {
      logger.error(`[SEARCH_CALENDAR_TOOL] ❌ Missing required parameters`);
      throw new Error("Missing required parameters: startTime and endTime are required");
    }

    // Convert time strings to millisecond timestamps
    logger.log(`[SEARCH_CALENDAR_TOOL] 🕒 Converting time strings to timestamps...`);
    logger.log(`[SEARCH_CALENDAR_TOOL]   - startTime input: ${params.startTime}`);
    logger.log(`[SEARCH_CALENDAR_TOOL]   - endTime input: ${params.endTime}`);

    // Parse YYYYMMDD hhmmss format
    const parseTimeString = (timeStr: string): number => {
      // Remove any extra spaces and split
      const cleaned = timeStr.trim().replace(/\s+/g, ' ');
      const parts = cleaned.split(' ');

      if (parts.length !== 2) {
        throw new Error(`Invalid time format: ${timeStr}. Expected format: YYYYMMDD hhmmss`);
      }

      const datePart = parts[0]; // YYYYMMDD
      const timePart = parts[1]; // hhmmss

      if (datePart.length !== 8 || timePart.length !== 6) {
        throw new Error(`Invalid time format: ${timeStr}. Expected format: YYYYMMDD hhmmss`);
      }

      const year = parseInt(datePart.substring(0, 4), 10);
      const month = parseInt(datePart.substring(4, 6), 10) - 1; // Month is 0-indexed
      const day = parseInt(datePart.substring(6, 8), 10);
      const hours = parseInt(timePart.substring(0, 2), 10);
      const minutes = parseInt(timePart.substring(2, 4), 10);
      const seconds = parseInt(timePart.substring(4, 6), 10);

      const date = new Date(year, month, day, hours, minutes, seconds);
      return date.getTime();
    };

    let startTimeMs: number;
    let endTimeMs: number;

    try {
      startTimeMs = parseTimeString(params.startTime);
      endTimeMs = parseTimeString(params.endTime);
    } catch (error) {
      logger.error(`[SEARCH_CALENDAR_TOOL] ❌ Time parsing error:`, error);
      throw new Error(`Invalid time format. Required format: YYYYMMDD hhmmss (e.g., 20240115 143000). Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (isNaN(startTimeMs) || isNaN(endTimeMs)) {
      logger.error(`[SEARCH_CALENDAR_TOOL] ❌ Invalid time format`);
      throw new Error("Invalid time format. Required format: YYYYMMDD hhmmss (e.g., 20240115 143000)");
    }

    logger.log(`[SEARCH_CALENDAR_TOOL] ✅ Time conversion successful`);
    logger.log(`[SEARCH_CALENDAR_TOOL]   - startTime timestamp: ${startTimeMs}`);
    logger.log(`[SEARCH_CALENDAR_TOOL]   - endTime timestamp: ${endTimeMs}`);

    // Get session context
    logger.log(`[SEARCH_CALENDAR_TOOL] 🔍 Attempting to get session context...`);
    const sessionContext = getLatestSessionContext();

    if (!sessionContext) {
      logger.error(`[SEARCH_CALENDAR_TOOL] ❌ FAILED: No active session found!`);
      logger.error(`[SEARCH_CALENDAR_TOOL]   - toolCallId: ${toolCallId}`);
      throw new Error("No active XY session found. Search calendar tool can only be used during an active conversation.");
    }

    logger.log(`[SEARCH_CALENDAR_TOOL] ✅ Session context found`);
    logger.log(`[SEARCH_CALENDAR_TOOL]   - sessionId: ${sessionContext.sessionId}`);
    logger.log(`[SEARCH_CALENDAR_TOOL]   - taskId: ${sessionContext.taskId}`);
    logger.log(`[SEARCH_CALENDAR_TOOL]   - messageId: ${sessionContext.messageId}`);

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    logger.log(`[SEARCH_CALENDAR_TOOL] 🔌 Getting WebSocket manager...`);
    const wsManager = getXYWebSocketManager(config);
    logger.log(`[SEARCH_CALENDAR_TOOL] ✅ WebSocket manager obtained`);

    // Build SearchCalendarEvent command
    logger.log(`[SEARCH_CALENDAR_TOOL] 📦 Building SearchCalendarEvent command...`);

    // Build intentParam with timeInterval and optional title
    const intentParam: any = {
      timeInterval: [startTimeMs, endTimeMs],
    };

    if (params.title) {
      intentParam.title = params.title;
      logger.log(`[SEARCH_CALENDAR_TOOL]   - Including title filter: ${params.title}`);
    }

    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "SearchCalendarEvent",
          bundleName: "com.huawei.hmos.calendardata",
          dimension: "",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam,
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
    logger.log(`[SEARCH_CALENDAR_TOOL] ⏳ Setting up promise to wait for calendar search response...`);
    logger.log(`[SEARCH_CALENDAR_TOOL]   - Timeout: 60 seconds`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.error(`[SEARCH_CALENDAR_TOOL] ⏰ Timeout: No response received within 60 seconds`);
        wsManager.off("data-event", handler);
        reject(new Error("检索日程超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {
        logger.log(`[SEARCH_CALENDAR_TOOL] 📨 Received data event:`, JSON.stringify(event));

        if (event.intentName === "SearchCalendarEvent") {
          logger.log(`[SEARCH_CALENDAR_TOOL] 🎯 SearchCalendarEvent event received`);
          logger.log(`[SEARCH_CALENDAR_TOOL]   - status: ${event.status}`);

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {
            logger.log(`[SEARCH_CALENDAR_TOOL] ✅ Calendar events retrieved successfully`);
            logger.log(`[SEARCH_CALENDAR_TOOL]   - outputs:`, JSON.stringify(event.outputs));

            // Return the result directly as requested
            const result = event.outputs.result;

            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result),
                },
              ],
            });
          } else {
            logger.error(`[SEARCH_CALENDAR_TOOL] ❌ Calendar event search failed`);
            logger.error(`[SEARCH_CALENDAR_TOOL]   - status: ${event.status}`);
            reject(new Error(`检索日程失败: ${event.status}`));
          }
        }
      };

      // Register event handler
      logger.log(`[SEARCH_CALENDAR_TOOL] 📡 Registering data-event handler on WebSocket manager`);
      wsManager.on("data-event", handler);

      // Send the command
      logger.log(`[SEARCH_CALENDAR_TOOL] 📤 Sending SearchCalendarEvent command...`);
      sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
      })
        .then(() => {
          logger.log(`[SEARCH_CALENDAR_TOOL] ✅ Command sent successfully, waiting for response...`);
        })
        .catch((error) => {
          logger.error(`[SEARCH_CALENDAR_TOOL] ❌ Failed to send command:`, error);
          clearTimeout(timeout);
          wsManager.off("data-event", handler);
          reject(error);
        });
    });
  },
};

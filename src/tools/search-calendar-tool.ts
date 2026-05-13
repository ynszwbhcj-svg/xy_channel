// Search Calendar Event tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
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
export function createSearchCalendarTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "search_calendar_event",
  label: "Search Calendar Event",
  description: `检索用户日历中的日程安排。根据时间范围和可选的日程标题进行检索。时间格式必须为：YYYYMMDD hhmmss（例如：20240115 143000）。

时间范围说明：
- 查询某一天的日程：使用该天的 00:00:00 到 23:59:59（例如：20240115 000000 到 20240115 235959）
- 查询上午的日程：使用 06:00:00 到 12:00:00
- 查询下午的日程：使用 12:00:00 到 18:00:00
- 查询晚上的日程：使用 18:00:00 到 23:59:59
- 查询某个时刻附近的日程：使用该时刻前后1小时的区间（例如：查询3点左右的日程，使用 14:00:00 到 16:00:00）

注意：
a. 该工具执行时间较长（最多60秒），请勿重复调用，超时或失败时最多重试一次。
b. 使用该工具之前需获取当前真实时间
c. 该工具仅支持不超过28天时间范围的日程查询，如果时间区间大于该窗口需要拆分多个时间窗口进行多次查询
d. 如果查询结果返回-303，代表查询结果为空

回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。
`,
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

    // Validate parameters
    if (!params.startTime || !params.endTime) {
      throw new Error("Missing required parameters: startTime and endTime are required");
    }

    // Convert time strings to millisecond timestamps

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
      throw new Error(`Invalid time format. Required format: YYYYMMDD hhmmss (e.g., 20240115 143000). Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (isNaN(startTimeMs) || isNaN(endTimeMs)) {
      throw new Error("Invalid time format. Required format: YYYYMMDD hhmmss (e.g., 20240115 143000)");
    }


    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build SearchCalendarEvent command

    // Build intentParam with timeInterval and optional title
    const intentParam: any = {
      timeInterval: [startTimeMs, endTimeMs],
    };

    if (params.title) {
      intentParam.title = params.title;
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

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        wsManager.off("data-event", handler);
        reject(new Error("检索日程超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {

        if (event.intentName === "SearchCalendarEvent") {

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {

            // 成功，直接返回完整的 event.outputs JSON 字符串
            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(event.outputs),
                },
              ],
            });
          } else {
            reject(new Error(`检索日程失败: ${event.status}`));
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
}

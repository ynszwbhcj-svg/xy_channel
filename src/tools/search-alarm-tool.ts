// Search Alarm tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

// Enum definitions for alarm search parameters
const RANGE_TYPE_VALUES = ["all", "next", "current"];
const ALARM_STATE_VALUES = [0, 1];
const DAYS_OF_WAKE_TYPE_VALUES = [0, 1, 2, 3, 4];

/**
 * XY search alarm tool - searches alarms on user's device.
 * Returns matching alarms based on various filter criteria.
 *
 * At least one search criterion must be provided.
 * Multiple criteria can be combined.
 */
export function createSearchAlarmTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "search_alarm",
  label: "Search Alarm",
  description: `检索用户设备上的闹钟。至少需要提供一个检索条件，多个条件可以组合使用。

使用示例：
- 查询所有闹钟：{"rangeType": "all"}
- 查询已开启的闹钟：{"alarmState": 1}
- 查询每天响铃的闹钟：{"daysOfWakeType": 2}
- 查询某个时间段的闹钟：{"startTime": "20240315 000000", "endTime": "20240315 235959"}

注意：
a. 操作超时时间为60秒，请勿重复调用此工具，如果超时或失败，最多重试一次。
b. 使用该工具之前需获取当前真实时间

回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。`,
  parameters: {
    type: "object",
    properties: {
      rangeType: {
        type: "string",
        enum: ["all", "next", "current"],
        description: "（检索条件之一）查询范围，枚举值：all=查询所有闹钟，next=查找下一个响铃闹钟，current=一小时内最近一次增查改的闹钟",
      },
      alarmState: {
        type: "number",
        enum: [0, 1],
        description: "（检索条件之一）闹钟开启状态，枚举值：0=关闭，1=开启",
      },
      daysOfWakeType: {
        type: "number",
        enum: [0, 1, 2, 3, 4],
        description: "（检索条件之一）闹钟响铃类型，枚举值：0=单次响铃，1=法定节假日，2=每天，3=自定义时间，4=法定工作日",
      },
      startTime: {
        type: "string",
        description: "（检索条件之一）时间间隔开始，格式 YYYYMMDD hhmmss（例如：20240315 000000），必须与 endTime 一起使用",
      },
      endTime: {
        type: "string",
        description: "（检索条件之一）时间间隔结束，格式 YYYYMMDD hhmmss（例如：20240315 235959），必须与 startTime 一起使用",
      },
    },
  },

  async execute(toolCallId: string, params: any) {

    // ===== Validate at least one search criterion is provided =====
    const hasRangeType = params.rangeType !== undefined && params.rangeType !== null;
    const hasAlarmState = params.alarmState !== undefined && params.alarmState !== null;
    const hasDaysOfWakeType = params.daysOfWakeType !== undefined && params.daysOfWakeType !== null;
    const hasStartTime = params.startTime !== undefined && params.startTime !== null;
    const hasEndTime = params.endTime !== undefined && params.endTime !== null;

    if (!hasRangeType && !hasAlarmState && !hasDaysOfWakeType && !hasStartTime && !hasEndTime) {
      throw new Error("至少需要提供一个检索条件：rangeType、alarmState、daysOfWakeType 或时间范围（startTime + endTime）");
    }

    // ===== Validate rangeType =====
    if (hasRangeType) {
      if (typeof params.rangeType !== "string") {
        throw new Error("rangeType must be a string");
      }
      if (!RANGE_TYPE_VALUES.includes(params.rangeType)) {
        throw new Error(`rangeType must be one of: ${RANGE_TYPE_VALUES.join(", ")}`);
      }
    }

    // ===== Validate alarmState =====
    if (hasAlarmState) {
      if (typeof params.alarmState !== "number") {
        throw new Error("alarmState must be a number");
      }
      if (!ALARM_STATE_VALUES.includes(params.alarmState)) {
        throw new Error(`alarmState must be one of: ${ALARM_STATE_VALUES.join(", ")}`);
      }
    }

    // ===== Validate daysOfWakeType =====
    if (hasDaysOfWakeType) {
      if (typeof params.daysOfWakeType !== "number") {
        throw new Error("daysOfWakeType must be a number");
      }
      if (!DAYS_OF_WAKE_TYPE_VALUES.includes(params.daysOfWakeType)) {
        throw new Error(`daysOfWakeType must be one of: ${DAYS_OF_WAKE_TYPE_VALUES.join(", ")}`);
      }
    }

    // ===== Validate time interval (startTime and endTime must be provided together) =====
    if (hasStartTime !== hasEndTime) {
      throw new Error("startTime 和 endTime 必须一起提供");
    }

    let timeInterval: [number, number] | null = null;
    if (hasStartTime && hasEndTime) {
      // Parse and convert startTime and endTime to timestamps

      const startTimeMs = parseAlarmTimeToTimestamp(params.startTime);
      const endTimeMs = parseAlarmTimeToTimestamp(params.endTime);

      if (startTimeMs === null) {
        throw new Error("Invalid startTime format. Required format: YYYYMMDD hhmmss (e.g., 20240315 000000)");
      }
      if (endTimeMs === null) {
        throw new Error("Invalid endTime format. Required format: YYYYMMDD hhmmss (e.g., 20240315 235959)");
      }

      if (startTimeMs >= endTimeMs) {
        throw new Error("startTime 必须早于 endTime");
      }

      timeInterval = [startTimeMs, endTimeMs];
    }

    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build SearchAlarm command

    // Build intentParam with provided search criteria
    const intentParam: any = {};

    if (hasRangeType) {
      intentParam.rangeType = params.rangeType;
    }
    if (hasAlarmState) {
      intentParam.alarmState = params.alarmState;
    }
    if (hasDaysOfWakeType) {
      intentParam.daysOfWakeType = params.daysOfWakeType;
    }
    if (timeInterval) {
      intentParam.timeInterval = timeInterval;
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
          intentName: "SearchAlarm",
          bundleName: "com.huawei.hmos.clock",
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
        reject(new Error("检索闹钟超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {

        if (event.intentName === "SearchAlarm") {

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
            reject(new Error(`检索闹钟失败: ${event.status}`));
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

/**
 * Parse alarmTime string (YYYYMMDD hhmmss) to timestamp in milliseconds
 * @param alarmTime - Time string in format "YYYYMMDD hhmmss" (e.g., "20240315 143000")
 * @returns Timestamp in milliseconds, or null if parsing fails
 */
function parseAlarmTimeToTimestamp(alarmTime: string): number | null {
  try {
    // Expected format: YYYYMMDD hhmmss
    // Example: 20240315 143000
    const trimmed = alarmTime.trim();

    // Check basic format (should have at least 13 characters: YYYYMMDD hhmmss)
    if (trimmed.length < 13) {
      return null;
    }

    // Extract date and time parts
    // Format: YYYYMMDD hhmmss
    const datePart = trimmed.substring(0, 8); // YYYYMMDD
    const timePart = trimmed.substring(8).trim(); // hhmmss (may have leading space)


    // Validate lengths
    if (datePart.length !== 8 || timePart.length !== 6) {
      return null;
    }

    // Parse components
    const year = parseInt(datePart.substring(0, 4), 10);
    const month = parseInt(datePart.substring(4, 6), 10);
    const day = parseInt(datePart.substring(6, 8), 10);
    const hour = parseInt(timePart.substring(0, 2), 10);
    const minute = parseInt(timePart.substring(2, 4), 10);
    const second = parseInt(timePart.substring(4, 6), 10);


    // Validate values
    if (isNaN(year) || isNaN(month) || isNaN(day) ||
        isNaN(hour) || isNaN(minute) || isNaN(second)) {
      return null;
    }

    // Validate ranges
    if (month < 1 || month > 12) {
      return null;
    }
    if (day < 1 || day > 31) {
      return null;
    }
    if (hour < 0 || hour > 23) {
      return null;
    }
    if (minute < 0 || minute > 59) {
      return null;
    }
    if (second < 0 || second > 59) {
      return null;
    }

    // Create Date object and get timestamp
    const date = new Date(year, month - 1, day, hour, minute, second);
    const timestamp = date.getTime();

    if (isNaN(timestamp)) {
      return null;
    }

    return timestamp;
  } catch (error) {
    return null;
  }
}

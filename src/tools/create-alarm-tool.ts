// Create Alarm tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

// Enum definitions for alarm parameters
const ALARM_SNOOZE_DURATION_VALUES = [5, 10, 15, 20, 25, 30];
const ALARM_SNOOZE_TOTAL_VALUES = [0, 1, 3, 5, 10];
const ALARM_RING_DURATION_VALUES = [1, 5, 10, 15, 20, 30];
const DAYS_OF_WAKE_TYPE_VALUES = [0, 1, 2, 3, 4];
const DAYS_OF_WEEK_VALUES = ["Mon", "Tues", "Wed", "Thur", "Fri", "Sat", "Sun"];

/**
 * XY create alarm tool - creates an alarm on user's device.
 * Requires alarmTime parameter. Other parameters are optional with sensible defaults.
 *
 * Time format: YYYYMMDD hhmmss (e.g., 20240315 143000)
 */
export function makeAlarmTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "create_alarm",
  label: "Create Alarm",
  description: `在用户设备上创建闹钟。

注意事项：
a. 操作超时时间为60秒，请勿重复调用此工具，如果超时或失败，最多重试一次。
b. 使用该工具之前需获取当前真实时间

回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。`,
  parameters: {
    type: "object",
    properties: {
      alarmTime: {
        type: "string",
        description: "闹钟时间，格式必须为：YYYYMMDD hhmmss（例如：20240315 143000，表示2024年3月15日14:30:00）",
      },
      alarmTitle: {
        type: "string",
        description: "闹钟名称/标题，默认为'闹钟'",
      },
      alarmSnoozeDuration: {
        type: "number",
        description: "小睡间隔（分钟），枚举值：5,10,15,20,25,30，默认10",
      },
      alarmSnoozeTotal: {
        type: "number",
        description: "再响次数，枚举值：0,1,3,5,10，默认0（表示不再响）",
      },
      alarmRingDuration: {
        type: "number",
        description: "响铃时长（分钟），枚举值：1,5,10,15,20,30，默认5",
      },
      daysOfWakeType: {
        type: "number",
        description: "闹钟响铃类型，枚举值：0=单次响铃，1=法定节假日，2=每天，3=自定义时间，4=法定工作日，默认0",
      },
      daysOfWeek: {
        // 不指定 type，允许传入数组或 JSON 字符串
        // 具体的类型验证和转换在 execute 函数内部进行
        description: "自定义响铃星期，仅当daysOfWakeType=3（自定义时间）时必需且有效，其他情况不要传递此参数。数组或JSON字符串，枚举值：Mon,Tues,Wed,Thur,Fri,Sat,Sun。",
      },
    },
    required: ["alarmTime"],
  },

  async execute(toolCallId: string, params: any) {

    // ===== Validate required parameter: alarmTime =====
    if (!params.alarmTime || typeof params.alarmTime !== "string") {
      throw new Error("Missing required parameter: alarmTime must be a string in format YYYYMMDD hhmmss");
    }

    // Parse and convert alarmTime to timestamp
    const alarmTimeMs = parseAlarmTimeToTimestamp(params.alarmTime);

    if (alarmTimeMs === null) {
      throw new Error("Invalid alarmTime format. Required format: YYYYMMDD hhmmss (e.g., 20240315 143000)");
    }


    // ===== Validate and set optional parameters with defaults =====

    // alarmTitle - default to "闹钟"
    const alarmTitle = params.alarmTitle && typeof params.alarmTitle === "string"
      ? params.alarmTitle
      : "闹钟";

    // alarmSnoozeDuration - default 10
    let alarmSnoozeDuration = 10;
    if (params.alarmSnoozeDuration !== undefined && params.alarmSnoozeDuration !== null) {
      if (typeof params.alarmSnoozeDuration !== "number") {
        throw new Error("alarmSnoozeDuration must be a number");
      }
      if (!ALARM_SNOOZE_DURATION_VALUES.includes(params.alarmSnoozeDuration)) {
        throw new Error(`alarmSnoozeDuration must be one of: ${ALARM_SNOOZE_DURATION_VALUES.join(", ")}`);
      }
      alarmSnoozeDuration = params.alarmSnoozeDuration;
    }

    // alarmSnoozeTotal - default 0
    let alarmSnoozeTotal = 0;
    if (params.alarmSnoozeTotal !== undefined && params.alarmSnoozeTotal !== null) {
      if (typeof params.alarmSnoozeTotal !== "number") {
        throw new Error("alarmSnoozeTotal must be a number");
      }
      if (!ALARM_SNOOZE_TOTAL_VALUES.includes(params.alarmSnoozeTotal)) {
        throw new Error(`alarmSnoozeTotal must be one of: ${ALARM_SNOOZE_TOTAL_VALUES.join(", ")}`);
      }
      alarmSnoozeTotal = params.alarmSnoozeTotal;
    }

    // alarmRingDuration - default 20
    let alarmRingDuration = 20;
    if (params.alarmRingDuration !== undefined && params.alarmRingDuration !== null) {
      if (typeof params.alarmRingDuration !== "number") {
        throw new Error("alarmRingDuration must be a number");
      }
      if (!ALARM_RING_DURATION_VALUES.includes(params.alarmRingDuration)) {
        throw new Error(`alarmRingDuration must be one of: ${ALARM_RING_DURATION_VALUES.join(", ")}`);
      }
      alarmRingDuration = params.alarmRingDuration;
    }

    // daysOfWakeType - default 0
    let daysOfWakeType = 0;
    if (params.daysOfWakeType !== undefined && params.daysOfWakeType !== null) {
      if (typeof params.daysOfWakeType !== "number") {
        throw new Error("daysOfWakeType must be a number");
      }
      if (!DAYS_OF_WAKE_TYPE_VALUES.includes(params.daysOfWakeType)) {
        throw new Error(`daysOfWakeType must be one of: ${DAYS_OF_WAKE_TYPE_VALUES.join(", ")}`);
      }
      daysOfWakeType = params.daysOfWakeType;
    }

    // daysOfWeek - only required when daysOfWakeType is 3
    let daysOfWeek: string[] = [];
    if (daysOfWakeType === 3) {
      if (!params.daysOfWeek) {
        throw new Error("daysOfWeek is required when daysOfWakeType is 3 (custom)");
      }

      // ===== 参数规范化：兼容数组和 JSON 字符串 =====
      let normalizedDaysOfWeek: string[] | null = null;

      // 情况1: 已经是数组
      if (Array.isArray(params.daysOfWeek)) {
        normalizedDaysOfWeek = params.daysOfWeek;
      }
      // 情况2: 是字符串，尝试解析为 JSON 数组
      else if (typeof params.daysOfWeek === 'string') {
        try {
          const parsed = JSON.parse(params.daysOfWeek);
          if (Array.isArray(parsed)) {
            normalizedDaysOfWeek = parsed;
          } else {
            throw new Error("daysOfWeek must be an array or a JSON string representing an array");
          }
        } catch (parseError) {
          throw new Error(`daysOfWeek must be a valid JSON array string. Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
        }
      }
      // 情况3: 其他类型，报错
      else {
        throw new Error(`daysOfWeek must be an array or a JSON string, got ${typeof params.daysOfWeek}`);
      }

      // 验证数组非空
      if (!normalizedDaysOfWeek || normalizedDaysOfWeek.length === 0) {
        throw new Error("daysOfWeek array cannot be empty");
      }

      // Validate each day
      for (const day of normalizedDaysOfWeek) {
        if (typeof day !== "string" || !DAYS_OF_WEEK_VALUES.includes(day)) {
          throw new Error(`daysOfWeek must contain only: ${DAYS_OF_WEEK_VALUES.join(", ")}`);
        }
      }

      daysOfWeek = normalizedDaysOfWeek;
    } else {
      // daysOfWakeType is not 3, daysOfWeek should not be provided
      if (params.daysOfWeek) {
      }
      // Explicitly set to empty array
      daysOfWeek = [];
    }

    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build CreateAlarm command

    // Build intentParam - only include daysOfWeek when daysOfWakeType is 3
    const intentParam: any = {
      entityName: "Alarm",
      alarmTime: alarmTimeMs,
      alarmTitle: alarmTitle,
      alarmSnoozeDuration: alarmSnoozeDuration,
      alarmSnoozeTotal: alarmSnoozeTotal,
      alarmRingDuration: alarmRingDuration,
      daysOfWakeType: daysOfWakeType,
    };

    // Only include daysOfWeek when daysOfWakeType is 3
    if (daysOfWakeType === 3 && daysOfWeek.length > 0) {
      intentParam.daysOfWeek = daysOfWeek;
    } else {
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
          intentName: "CreateAlarm",
          bundleName: "com.huawei.hmos.clock",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam: intentParam,
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
        reject(new Error("创建闹钟超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {

        if (event.intentName === "CreateAlarm") {

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
            reject(new Error(`创建闹钟失败: ${event.status}`));
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

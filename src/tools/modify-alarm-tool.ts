// Modify Alarm tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

// Enum definitions for alarm parameters (same as create-alarm-tool)
const ALARM_SNOOZE_DURATION_VALUES = [5, 10, 15, 20, 25, 30];
const ALARM_SNOOZE_TOTAL_VALUES = [0, 1, 3, 5, 10];
const ALARM_RING_DURATION_VALUES = [1, 5, 10, 15, 20, 30];
const DAYS_OF_WAKE_TYPE_VALUES = [0, 1, 2, 3, 4];
const DAYS_OF_WEEK_VALUES = ["Mon", "Tues", "Wed", "Thur", "Fri", "Sat", "Sun"];

/**
 * XY modify alarm tool - modifies an existing alarm on user's device.
 * Requires entityId from search_alarm or create_alarm tool.
 *
 * Prerequisites:
 * 1. Call search_alarm or create_alarm tool first to get entityId
 * 2. Use the entityId to identify which alarm to modify
 */
export function createModifyAlarmTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "modify_alarm",
  label: "Modify Alarm",
  description: `修改用户设备上已存在的闹钟。

使用流程：
1. 先调用 search_alarm 工具查询闹钟，获取 entityId，
2. 调用此工具修改闹钟，传入 entityId 和需要修改的参数
3. 其余不涉及修改的参数，如果search_alarm 或 create_alarm的结果中有相应的值，需要一并填上，需要与原有的保持一致，防止不填采用默认值

注意事项：操作超时时间为60秒，请勿重复调用此工具，如果超时或失败，最多重试一次。

回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。`,
  parameters: {
    type: "object",
    properties: {
      entityId: {
        type: "string",
        description: "（必需）闹钟的唯一标识符，必须先通过 search_alarm 或 create_alarm 工具获取",
      },
      alarmTime: {
        type: "string",
        description: "（可选）闹钟时间，格式必须为：YYYYMMDD hhmmss（例如：20240315 143000）",
      },
      alarmTitle: {
        type: "string",
        description: "（可选）闹钟名称/标题",
      },
      alarmState: {
        type: "number",
        description: "（可选）闹钟开启状态，枚举值：0=关闭，1=开启",
      },
      alarmSnoozeDuration: {
        type: "number",
        description: "（可选）小睡间隔（分钟），枚举值：5,10,15,20,25,30",
      },
      alarmSnoozeTotal: {
        type: "number",
        description: "（可选）再响次数，枚举值：0,1,3,5,10",
      },
      alarmRingDuration: {
        type: "number",
        description: "（可选）响铃时长（分钟），枚举值：1,5,10,15,20,30",
      },
      daysOfWakeType: {
        type: "number",
        description: "（可选）闹钟响铃类型，枚举值：0=单次，1=法定节假日，2=每天，3=自定义，4=法定工作日",
      },
      daysOfWeek: {
        // 不指定 type，允许传入数组或 JSON 字符串
        // 具体的类型验证和转换在 execute 函数内部进行
        description: "（可选）自定义响铃星期，仅当daysOfWakeType=3（自定义时间）时必需且有效，其他情况不要传递此参数。数组或JSON字符串，枚举值：Mon,Tues,Wed,Thur,Fri,Sat,Sun",
      },
    },
    required: ["entityId"],
  },

  async execute(toolCallId: string, params: any) {

    // ===== Validate required parameter: entityId =====
    if (!params.entityId || typeof params.entityId !== "string") {
      throw new Error("Missing required parameter: entityId must be a string obtained from search_alarm or create_alarm");
    }


    // ===== Build intentParam with provided parameters =====
    const intentParam: any = {
      entityName: "Alarm",
      entityId: params.entityId,
    };

    // Parse and convert alarmTime if provided
    if (params.alarmTime !== undefined && params.alarmTime !== null) {
      if (typeof params.alarmTime !== "string") {
        throw new Error("alarmTime must be a string in format YYYYMMDD hhmmss");
      }

      const alarmTimeMs = parseAlarmTimeToTimestamp(params.alarmTime);

      if (alarmTimeMs === null) {
        throw new Error("Invalid alarmTime format. Required format: YYYYMMDD hhmmss (e.g., 20240315 143000)");
      }

      intentParam.alarmTime = alarmTimeMs;
    }

    // Add alarmTitle if provided
    if (params.alarmTitle !== undefined && params.alarmTitle !== null) {
      if (typeof params.alarmTitle !== "string") {
        throw new Error("alarmTitle must be a string");
      }
      intentParam.alarmTitle = params.alarmTitle;
    }

    // Add alarmState if provided
    if (params.alarmState !== undefined && params.alarmState !== null) {
      if (typeof params.alarmState !== "number") {
        throw new Error("alarmState must be a number");
      }
      if (!ALARM_STATE_VALUES.includes(params.alarmState)) {
        throw new Error(`alarmState must be one of: ${ALARM_STATE_VALUES.join(", ")}`);
      }
      intentParam.alarmState = params.alarmState;
    }

    // Add alarmSnoozeDuration if provided
    if (params.alarmSnoozeDuration !== undefined && params.alarmSnoozeDuration !== null) {
      if (typeof params.alarmSnoozeDuration !== "number") {
        throw new Error("alarmSnoozeDuration must be a number");
      }
      if (!ALARM_SNOOZE_DURATION_VALUES.includes(params.alarmSnoozeDuration)) {
        throw new Error(`alarmSnoozeDuration must be one of: ${ALARM_SNOOZE_DURATION_VALUES.join(", ")}`);
      }
      intentParam.alarmSnoozeDuration = params.alarmSnoozeDuration;
    }

    // Add alarmSnoozeTotal if provided
    if (params.alarmSnoozeTotal !== undefined && params.alarmSnoozeTotal !== null) {
      if (typeof params.alarmSnoozeTotal !== "number") {
        throw new Error("alarmSnoozeTotal must be a number");
      }
      if (!ALARM_SNOOZE_TOTAL_VALUES.includes(params.alarmSnoozeTotal)) {
        throw new Error(`alarmSnoozeTotal must be one of: ${ALARM_SNOOZE_TOTAL_VALUES.join(", ")}`);
      }
      intentParam.alarmSnoozeTotal = params.alarmSnoozeTotal;
    }

    // Add alarmRingDuration if provided
    if (params.alarmRingDuration !== undefined && params.alarmRingDuration !== null) {
      if (typeof params.alarmRingDuration !== "number") {
        throw new Error("alarmRingDuration must be a number");
      }
      if (!ALARM_RING_DURATION_VALUES.includes(params.alarmRingDuration)) {
        throw new Error(`alarmRingDuration must be one of: ${ALARM_RING_DURATION_VALUES.join(", ")}`);
      }
      intentParam.alarmRingDuration = params.alarmRingDuration;
    }

    // Add daysOfWakeType if provided
    if (params.daysOfWakeType !== undefined && params.daysOfWakeType !== null) {
      if (typeof params.daysOfWakeType !== "number") {
        throw new Error("daysOfWakeType must be a number");
      }
      if (!DAYS_OF_WAKE_TYPE_VALUES.includes(params.daysOfWakeType)) {
        throw new Error(`daysOfWakeType must be one of: ${DAYS_OF_WAKE_TYPE_VALUES.join(", ")}`);
      }
      intentParam.daysOfWakeType = params.daysOfWakeType;
    }

    // Add daysOfWeek if provided - only valid when daysOfWakeType is 3
    if (params.daysOfWeek !== undefined && params.daysOfWeek !== null) {
      // Check if daysOfWakeType is 3 or will be set to 3
      const targetDaysOfWakeType = params.daysOfWakeType !== undefined ? params.daysOfWakeType : null;

      if (targetDaysOfWakeType !== null && targetDaysOfWakeType !== 3) {
        // Skip processing daysOfWeek when daysOfWakeType is not 3
      } else {
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

        intentParam.daysOfWeek = normalizedDaysOfWeek;
      }
    }

    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build ModifyAlarm command
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "ModifyAlarm",
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
        reject(new Error("修改闹钟超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {

        if (event.intentName === "ModifyAlarm") {

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
            reject(new Error(`修改闹钟失败: ${event.status}`));
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

// Enum for alarm state
const ALARM_STATE_VALUES = [0, 1];

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

// Calendar event tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY calendar event tool - creates a calendar event on user's device.
 * Requires title, dtStart (start time), and dtEnd (end time) parameters.
 * Time format must be: yyyy-mm-dd hh:mm:ss
 */
export function createCalendarTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "create_calendar_event",
  label: "Create Calendar Event",
  description: `在用户设备上创建日程。需要提供日程标题、开始时间和结束时间。时间格式必须为：yyyy-mm-dd hh:mm:ss（例如：2024-01-15 14:30:00）。注意：该工具执行时间较长（最多60秒），请勿重复调用，超时或失败时最多重试一次。
  注意事项：使用该工具之前需获取当前真实时间

  回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。
  `,
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

    // Validate parameters
    if (!params.title || !params.dtStart || !params.dtEnd) {
      throw new Error("Missing required parameters: title, dtStart, and dtEnd are required");
    }

    // Convert time strings to millisecond timestamps

    const dtStartMs = new Date(params.dtStart).getTime();
    const dtEndMs = new Date(params.dtEnd).getTime();

    if (isNaN(dtStartMs) || isNaN(dtEndMs)) {
      throw new Error("Invalid time format. Required format: yyyy-mm-dd hh:mm:ss (e.g., 2024-01-15 14:30:00)");
    }


    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build CreateCalendarEvent command
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

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        wsManager.off("data-event", handler);
        reject(new Error("创建日程超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {

        if (event.intentName === "CreateCalendarEvent") {

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {

            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(event.outputs),
                },
              ],
            });
          } else {
            reject(new Error(`创建日程失败: ${event.status}`));
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

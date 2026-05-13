// Call Phone tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY call phone tool - makes a phone call on user's device.
 * Requires phoneNumber parameter and optional slotId (0 for primary SIM, 1 for secondary SIM).
 */
export function createCallPhoneTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "call_phone",
  label: "Call Phone",
  description: "拨打电话。需要提供要拨打的电话号码。slotId参数可选，默认为0（主卡），如果用户明确要求使用副卡则设置为1。注意:操作超时时间为60秒,请勿重复调用此工具,如果超时或失败,最多重试一次。回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。",
  parameters: {
    type: "object",
    properties: {
      phoneNumber: {
        type: "string",
        description: "要拨打的电话号码",
      },
      slotId: {
        type: "number",
        description: "SIM卡槽ID，默认为0（主卡），设置为1表示副卡。仅当用户明确要求使用副卡时才设置为1",
        default: 0,
      },
    },
    required: ["phoneNumber"],
  },

  async execute(toolCallId: string, params: any) {

    // Validate phoneNumber parameter
    if (!params.phoneNumber || typeof params.phoneNumber !== "string" || params.phoneNumber.trim() === "") {
      throw new Error("Missing required parameter: phoneNumber must be a non-empty string");
    }

    // Set default slotId if not provided
    const slotId = params.slotId !== undefined && params.slotId !== null ? params.slotId : 0;

    // Validate slotId (must be 0 or 1)
    if (slotId !== 0 && slotId !== 1) {
      throw new Error("Invalid slotId: must be 0 (primary SIM) or 1 (secondary SIM)");
    }


    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build StartCall command
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "StartCall",
          bundleName: "com.huawei.hmos.aidispatchservice",
          dimension: "",
          needUnlock: true,
          actionResponse: true,
          timeOut: 5,
          intentParam: {
            phoneNumber: params.phoneNumber.trim(),
            slotId: slotId,
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

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        wsManager.off("data-event", handler);
        reject(new Error("拨打电话超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {

        if (event.intentName === "StartCall") {

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
            reject(new Error(`拨打电话失败: ${event.status}`));
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

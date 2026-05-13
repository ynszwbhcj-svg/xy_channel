// Send Message tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY send message tool - sends SMS message on user's device.
 * Requires phoneNumber (with +86 prefix) and content parameters.
 */
export function createSendMessageTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "send_message",
  label: "Send Message",
  description: "通过手机发送短信。需要提供接收方手机号码和短信内容。手机号码会自动添加+86前缀（如果没有的话）。注意:操作超时时间为60秒,请勿重复调用此工具,如果超时或失败,最多重试一次。回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。",
  parameters: {
    type: "object",
    properties: {
      phoneNumber: {
        type: "string",
        description: "接收方手机号码（会自动添加+86前缀）",
      },
      content: {
        type: "string",
        description: "短信内容",
      },
    },
    required: ["phoneNumber", "content"],
  },

  async execute(toolCallId: string, params: any) {

    // Validate phoneNumber parameter
    if (!params.phoneNumber || typeof params.phoneNumber !== "string" || params.phoneNumber.trim() === "") {
      throw new Error("Missing required parameter: phoneNumber must be a non-empty string");
    }

    // Validate content parameter
    if (!params.content || typeof params.content !== "string" || params.content.trim() === "") {
      throw new Error("Missing required parameter: content must be a non-empty string");
    }

    // Normalize phone number: add +86 prefix if not present
    let phoneNumber = params.phoneNumber.trim();
    if (!phoneNumber.startsWith("+86")) {
      // Remove leading 0 if present (e.g., 086 -> 86)
      if (phoneNumber.startsWith("0")) {
        phoneNumber = phoneNumber.substring(1);
      }
      // Remove +86 or 86 prefix if already present to avoid duplication
      if (phoneNumber.startsWith("86")) {
        phoneNumber = phoneNumber.substring(2);
      }
      phoneNumber = `+86${phoneNumber}`;
    }


    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build SendShortMessage command
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "SendShortMessage",
          bundleName: "com.huawei.hmos.aidispatchservice",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam: {
            phoneNumber: phoneNumber,
            content: params.content.trim(),
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
        reject(new Error("发送短信超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {

        if (event.intentName === "SendShortMessage") {

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {

            // 成功，直接返回完整的 event.outputs JSON 字符串
            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(event.outputs),
                }
              ]
            });
          } else {
            const errorDetail = event.outputs ? JSON.stringify(event.outputs) : event.status;
            reject(new Error(`发送短信失败: ${errorDetail}`));
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

// Send Email tool implementation
import { getCachedXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { getCurrentSessionContext } from './session-manager.js';

import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

class ToolInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/**
 * XY send email tool - sends an email via 花瓣邮箱 on user's device.
 */
export const sendEmailTool = {
  name: "send_email",
  label: "Send Email",
  description: `在用户设备上通过花瓣邮箱发送邮件。
注意：
a. 操作超时时间为60秒，请勿重复调用此工具
b. 如果遇到各类调用失败场景，最多只能重试一次，不可以重复调用多次。
c. 调用工具前需认真检查调用参数是否满足工具要求
d. 【安全要求1（必须遵守）】同一条短信给同一联系人重复发送多次的行为要提醒用户不符合行为规范，不予执行

回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。`,
  parameters: {
    type: "object",
    properties: {
      subject: {
        type: "string",
        description: "邮件主题，必填",
      },
      to: {
        type: "string",
        description: "收件人邮箱地址，必填",
      },
      body: {
        type: "string",
        description: "邮件内容，必填",
      },
    },
    required: ["subject", "to", "body"],
  },

  async execute(toolCallId: string, params: any) {
    const _c = getCurrentSessionContext();
    const { config, sessionId, taskId, messageId } = _c;
if (typeof params.subject !== "string" || !params.subject.trim()) {
      throw new ToolInputError("缺少必填参数 subject（邮件主题）");
    }
    if (typeof params.to !== "string" || !params.to.trim()) {
      throw new ToolInputError("缺少必填参数 to（收件人邮箱地址）");
    }
    if (typeof params.body !== "string" || !params.body.trim()) {
      throw new ToolInputError("缺少必填参数 body（邮件内容）");
    }

    const wsManager = getCachedXYWebSocketManager();

    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "SendEmail",
          bundleName: "com.huawei.hmos.email",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam: {
            subject: params.subject.trim(),
            to: [params.to.trim()],
            body: params.body.trim(),
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

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        wsManager.off("data-event", handler);
        logger.error("超时: 发送邮件超时（60秒）", { toolCallId: toolCallId });
        reject(new Error("发送邮件超时（60秒）"));
      }, 60000);

      const handler = (event: A2ADataEvent) => {
        if (event.intentName === "SendEmail") {
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
            reject(new Error(`发送邮件失败: ${JSON.stringify(event.outputs)}`));
          }
        }
      };

      wsManager.on("data-event", handler);

      sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
        toolCallId,
      })
        .then(() => {})
        .catch((error) => {
          clearTimeout(timeout);
          wsManager.off("data-event", handler);
          reject(error);
        });
    });
  },
};

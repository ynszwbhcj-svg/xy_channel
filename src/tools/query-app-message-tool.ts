// QueryAppMessage tool implementation
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import type { A2ADataEvent } from "../types.js";

class ToolInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/**
 * 查询指定时间范围内的设备通知消息。
 */
export function createQueryAppMessageTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "query_app_message",
  label: "Query App Message",
  description: `获取指定时间范围内的设备通知消息。适用于需要查询历史通知、按应用筛选通知、或仅查看未读通知的场景。支持按时间范围、应用包名、已读/未读状态进行过滤。
注意：
a. 操作超时时间为60秒，请勿重复调用此工具
b. 如果遇到各类调用失败场景，最多只能重试一次，不可以重复调用多次。
c. 调用工具前需认真检查调用参数是否满足工具要求

回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。`,
  parameters: {
    type: "object",
    properties: {
      startTime: {
        type: "string",
        description: "查询通知的起始时间（ISO 8601 字符串）。若endTime为空，则默认值为24小时前。",
      },
      endTime: {
        type: "string",
        description: "查询通知的结束时间（ISO 8601 字符串）。默认值为当前时间。",
      },
      packageName: {
        type: "string",
        description: "按应用名称过滤通知（例如「微信」「小红书」）。默认值为所有应用。",
      },
      state: {
        type: "integer",
        description: "通知的已读/未读状态。0 = 全部，1 = 仅未读。默认值为 0。",
      },
    },
    required: [],
  },

  async execute(_toolCallId: string, params: any) {
    const wsManager = getXYWebSocketManager(config);

    const intentParam: Record<string, any> = {};
    if (params.startTime !== undefined) intentParam.startTime = params.startTime;
    if (params.endTime !== undefined) intentParam.endTime = params.endTime;
    if (params.packageName !== undefined) intentParam.packageName = params.packageName;
    if (params.state !== undefined) {
      if (params.state !== 0 && params.state !== 1) {
        throw new ToolInputError("state 参数只能为 0（全部）或 1（仅未读）");
      }
      intentParam.state = params.state;
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
          intentName: "QueryAppMessage",
          bundleName: "com.huawei.hmos.vassistant",
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

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        wsManager.off("data-event", handler);
        reject(new Error("查询通知消息超时（60秒）"));
      }, 60000);

      const handler = (event: A2ADataEvent) => {
        if (event.intentName === "QueryAppMessage") {
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
            reject(new Error(`查询通知消息失败: ${event.status}`));
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
}

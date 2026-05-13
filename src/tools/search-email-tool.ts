// Search Email tool implementation
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY search email tool - searches emails on user's device (花瓣邮箱).
 * Returns matching emails based on query text and search type.
 */
export function createSearchEmailTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "search_email",
  label: "Search Email",
  description: `检索用户花瓣邮箱中的邮件。根据查询语料和搜索类型检索邮件。

使用示例：
- 通用搜索：{"queryText": "个人所得税邮件", "type": 0}
- 按主题搜索：{"queryText": "会议纪要", "type": 1}
- 按发件人搜索：{"queryText": "张三", "type": 2}
- 按收件人搜索：{"queryText": "李四", "type": 3}

注意：
a. 操作超时时间为60秒，请勿重复调用此工具，如果超时或失败，最多重试一次。
b. 使用该工具之前需获取当前真实时间

回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。`,
  parameters: {
    type: "object",
    properties: {
      queryText: {
        type: "string",
        description: "查询语料，用于搜索邮件的关键词或语句",
      },
      type: {
        type: "number",
        enum: [0, 1, 2, 3],
        description: "搜索类型：0=全部(all)，1=主题(subject)，2=发件人(fromList)，3=收件人(toList)。默认为0",
      },
    },
    required: ["queryText"],
  },

  async execute(_toolCallId: string, params: any) {
    // ===== Validate queryText =====
    if (!params.queryText || typeof params.queryText !== "string" || !params.queryText.trim()) {
      throw new Error("queryText 为必填参数，且不能为空字符串");
    }

    // ===== Validate type =====
    const searchType = params.type ?? 0;
    if (typeof searchType !== "number" || ![0, 1, 2, 3].includes(searchType)) {
      throw new Error("type 必须是 0-3 的整数：0=全部，1=主题，2=发件人，3=收件人");
    }

    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build SearchEmails command
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "SearchEmails",
          bundleName: "com.huawei.hmos.email",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam: {
            type: searchType,
            queryText: params.queryText.trim(),
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
        reject(new Error("检索邮件超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {
        if (event.intentName === "SearchEmails") {
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
            reject(new Error(`检索邮件失败: ${event.status}`));
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

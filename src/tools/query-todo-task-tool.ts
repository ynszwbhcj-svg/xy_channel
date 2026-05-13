// QueryTodoTask tool implementation
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
 * 获取指定时间范围内的全局待办任务列表。
 */
export function createQueryTodoTaskTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "query_todo_task",
  label: "Query Todo Task",
  description: `获取指定时间范围内的全局待办任务列表。适用于需要查询历史任务、按完成状态筛选、或仅查看待处理任务的场景。支持按时间范围、任务状态进行过滤。
注意：
a. 操作超时时间为60秒，请勿重复调用此工具
b. 如果遇到各类调用失败场景，最多只能重试一次，不可以重复调用多次。
c. 调用工具前需认真检查调用参数是否满足工具要求
d. 当只传入 startTime 时，返回该时间点之后的所有任务；当只传入 endTime 时，返回该时间点之前的所有任务；两者都不传则返回所有时间段的任务。

回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。`,
  parameters: {
    type: "object",
    properties: {
      startTime: {
        type: "string",
        description: "查询创建时间大于此值的任务（ISO 8601 字符串，如 2024-01-01T00:00:00Z）。",
      },
      endTime: {
        type: "string",
        description: "查询创建时间小于此值的任务（ISO 8601 字符串，如 2024-01-31T23:59:59Z）。",
      },
      status: {
        type: "string",
        description: '任务完成状态过滤。可选值为 "all"、"completed"、"pending"。默认为 "all"。',
      },
    },
    required: [],
  },

  async execute(_toolCallId: string, params: any) {
    const { status } = params;

    if (status && !["all", "completed", "pending"].includes(status)) {
      throw new ToolInputError('status 参数只能为 "all"、"completed" 或 "pending"');
    }

    const wsManager = getXYWebSocketManager(config);

    const intentParam: Record<string, any> = {};
    if (params.startTime !== undefined) intentParam.startTime = params.startTime;
    if (params.endTime !== undefined) intentParam.endTime = params.endTime;
    if (status !== undefined) intentParam.status = status;

    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "QueryTodoTask",
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
        reject(new Error("查询待办任务超时（60秒）"));
      }, 60000);

      const handler = (event: A2ADataEvent) => {
        if (event.intentName === "QueryTodoTask") {
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
            reject(new Error(`查询待办任务失败: ${event.status}`));
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

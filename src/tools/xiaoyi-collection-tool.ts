// XiaoYi Collection tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * Duck-typed ToolInputError: openclaw 按 .name 字段匹配，不用 instanceof。
 * 抛出此错误会让 openclaw 返回 HTTP 400 而非 500，
 * LLM 会将其识别为参数错误而非瞬时故障，不会触发重试。
 */
class ToolInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/**
 * XY collection tool - retrieves user's collection data from XiaoYi.
 * Returns personalized knowledge data saved in user's collection.
 */
export function createXiaoyiCollectionTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "query_collection",
  label: "XiaoYi Collection",
  description: `检索用户在小艺收藏中记下来的公共知识数据，本技能支持查询用户收藏的公共知识数据，也可以根据特定语义化描述进行特定内容的检索，通过参数进行控制。本技能返回结果中，linkTitle是收藏内容的标题，description是对收藏内容的总结，label是收藏内容的标签，linkUrl是可以直接访问的原始内容链接。如果你认为某条数据对用户交互有用，可以通过linkUrl抓取更加丰富的原始数据。
  注意:
  a. 操作超时时间为60秒,请勿重复调用此工具
  b. 如果遇到各类调用失败场景,最多只能重试一次，不可以重复调用多次。
  c. 调用工具前需认真检查调用参数是否满足工具要求
  d. 如果用户希望获取文件，可以使用call_device_tool工具调用upload_file工具完成文件上传

  回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。
  `,
  parameters: {
    type: "object",
    properties: {
      queryAll: {
        type: "string",
        description: "非必填参数，描述是否需要查询用户所有收藏数据。如果填入true则表示获取用户所有公共知识数据，其他参数无效。",
      },
      query: {
        type: "string",
        description: "非必填参数，queryAll不填或者为false则必填。用户的查询条件，可按照用户query进行检索。",
      },
    },
    required: [],
  },

  async execute(toolCallId: string, params: any) {

    // Validate parameters
    const queryAll = params.queryAll;
    const query = params.query;

    if (queryAll !== "true" && (!query || typeof query !== "string")) {
      throw new ToolInputError("queryAll不为true时，query参数必填");
    }

    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build intentParam
    const intentParam: Record<string, string> = {};
    if (queryAll === "true") {
      intentParam.queryAll = "true";
    } else {
      intentParam.queryAll = "false";
      intentParam.query = query;
    }

    // Build QueryCollection command
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "QueryCollection",
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

    // Send command and wait for response (60 second timeout)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        wsManager.off("data-event", handler);
        reject(new Error("查询小艺收藏超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {

        if (event.intentName === "QueryCollection") {

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
            reject(new Error(`查询小艺收藏失败: ${event.status}`));
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

// XiaoYi Delete Collection tool implementation
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
 * XY delete collection tool - deletes data from user's XiaoYi collection.
 */
export function createXiaoyiDeleteCollectionTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "delete_collection",
  label: "Delete XiaoYi Collection",
  description: `从小艺收藏中删除之前已保存的公共知识数据。任何用户希望删除已保存到个人知识库的数据都可以调用本技能。如果用户想更新之前的收藏数据，需要先query获取itemId然后再delete，最后执行Add，按照这个步骤完成收藏数据更新。
  注意:
  a. 操作超时时间为60秒,请勿重复调用此工具
  b. 如果遇到各类调用失败场景,最多只能重试一次，不可以重复调用多次。
  c. 调用工具前需认真检查调用参数是否满足工具要求

  回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。
  `,
  parameters: {
    type: "object",
    properties: {
      itemIds: {
        // 不指定 type，允许传入数组或 JSON 字符串
        // 具体的类型验证和转换在 execute 函数内部进行
        description: "准备删除的数据的itemId合集。itemId可以由用户指定，也可以从之前检索回来的收藏数据项的itemId字段获取。",
      },
    },
    required: ["itemIds"],
  },

  async execute(toolCallId: string, params: any) {

    // ===== 参数规范化：兼容数组和 JSON 字符串 =====
    let itemIds: string[] | null = null;

    if (!params.itemIds) {
      throw new ToolInputError("缺少必填参数: itemIds");
    }

    // 情况1: 已经是数组
    if (Array.isArray(params.itemIds)) {
      itemIds = params.itemIds;
    }
    // 情况2: 是字符串，尝试解析为 JSON 数组
    else if (typeof params.itemIds === 'string') {
      try {
        const parsed = JSON.parse(params.itemIds);
        if (Array.isArray(parsed)) {
          itemIds = parsed;
        } else {
          throw new ToolInputError("itemIds must be an array or a JSON string representing an array");
        }
      } catch (parseError) {
        if (parseError instanceof ToolInputError) throw parseError;
        throw new ToolInputError(`itemIds must be a valid JSON array string. Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      }
    }
    // 情况3: 其他类型，报错
    else {
      throw new ToolInputError(`itemIds must be an array or a JSON string, got ${typeof params.itemIds}`);
    }

    // 验证数组非空
    if (!itemIds || itemIds.length === 0) {
      throw new ToolInputError("itemIds array cannot be empty");
    }

    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build DeleteCollection command
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "DeleteCollection",
          bundleName: "com.huawei.hmos.vassistant",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam: {
            itemIds,
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
        reject(new Error("删除小艺收藏超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {

        if (event.intentName === "DeleteCollection") {

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {

            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(event.outputs),
                }
              ]
            });
          } else {
            reject(new Error(`删除小艺收藏失败: ${event.status}`));
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

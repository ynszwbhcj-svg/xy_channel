// Note tool implementation
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
 * XY note tool - creates a note on user's device.
 * Requires title and content parameters.
 */
export function createNoteTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "create_note",
  label: "Create Note",
  description: `在用户设备上创建备忘录。需要提供备忘录标题和内容。
  注意:
  a. 操作超时时间为60秒,请勿重复调用此工具
  b. 如果遇到各类调用失败场景,最多只能重试一次，不可以重复调用多次。
  c. 调用工具前需认真检查调用参数是否满足工具要求

  回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。
  `,
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "备忘录标题，必填",
      },
      content: {
        type: "string",
        description: "备忘录内容，必填",
      },
    },
    required: ["title", "content"],
  },

  async execute(toolCallId: string, params: any) {

    // Validate parameters — 抛 ToolInputError 而非普通 Error，
    // 让 openclaw 返回 400 而非 500，明确告知 LLM 这是参数错误，不应重试。
    if (typeof params.title !== "string" || !params.title) {
      throw new ToolInputError("缺少必填参数 title（备忘录标题）");
    }
    if (typeof params.content !== "string" || !params.content) {
      throw new ToolInputError("缺少必填参数 content（备忘录内容）");
    }

    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build CreateNote command
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "CreateNote",
          bundleName: "com.huawei.hmos.notepad",
          dimension: "",
          needUnlock: true,
          actionResponse: true,
          timeOut: 5,
          intentParam: {
            title: params.title,
            content: params.content,
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
        reject(new Error("创建备忘录超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {

        if (event.intentName === "CreateNote") {
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
            reject(new Error(`创建备忘录失败: ${event.status}`));
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
      }).catch((error) => {
        clearTimeout(timeout);
        wsManager.off("data-event", handler);
        reject(error);
      });
    });
  },
};
}

// function-call.tool.ts
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getCurrentSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * function_call_tool - 统一调用已安装 skill 中声明的工具。
 *
 * 使用约束：
 * - 必须通过 pluginId + toolName 定位工具
 * - pluginType 决定执行路径（Cloud / MCP / Device）
 * - 所有路径最终返回统一 envelope：{ ok, data, error }
 *
 */
export const functionCallTool: ChannelAgentTool = {
  name: "function_call_tool",
  label: "Function Call Tool",
  description: `调用已安装 skill 中声明的工具。

【重要】使用约束：
- 必须显式传入 pluginId 和 toolName
- 工具定义来自 references/tools/<pluginId>__<toolName>.json
- 不要猜测 pluginId / toolName

示例：
- pluginId: plugin_001
- toolName: weather_query
- arguments: { city: "北京" }`,

  parameters: {
    type: "object",
    properties: {
      pluginId: {
        type: "string",
        description: "插件实例 ID，如 plugin_001",
      },
      toolName: {
        type: "string",
        description: "插件内函数名，如 weather_query",
      },
      arguments: {
        type: "object",
        description: "工具参数，字段遵循对应 tool JSON 的 arguments schema",
        additionalProperties: true,
      },
    },
    required: ["pluginId", "toolName", "arguments"],
  },

  async execute(toolCallId: string, params: any) {
    // ---------- 参数校验 ----------
    if (!params.pluginId || typeof params.pluginId !== "string") {
      throw new Error("Missing required parameter: pluginId");
    }

    if (!params.toolName || typeof params.toolName !== "string") {
      throw new Error("Missing required parameter: toolName");
    }

    if (!params.arguments || typeof params.arguments !== "object") {
      throw new Error("Missing required parameter: arguments must be an object");
    }

    // ---------- Session 校验 ----------
    const sessionContext = getCurrentSessionContext();
    if (!sessionContext) {
      throw new Error(
        "No active XY session found. function_call_tool can only be used during an active conversation."
      );
    }

    const { config, sessionId, taskId, messageId } = sessionContext;
    const wsManager = getXYWebSocketManager(config);

    // ---------- 构造 A2A command ----------
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "FunctionCall",
          bundleName: "com.huawei.hmos.aidispatchservice",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam: {
            pluginId: params.pluginId,
            toolName: params.toolName,
            arguments: params.arguments,
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

    // ---------- 发送命令并等待结果 ----------
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        wsManager.off("data-event", handler);
        reject(new Error("function_call_tool 超时（60秒）"));
      }, 60000);

      const handler = (event: A2ADataEvent) => {
        if (event.intentName === "FuctionCall") {
          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {
            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: true,
                    data: event.outputs,
                    error: null,
                  }),
                },
              ],
            });
          } else {
            const errorDetail = {
                "code": "TOOL_NOT_FOUND",
                "message": `未找到 ${params.pluginId}/${params.toolName}`,
                "retryable": false,
                "detail": {
                    "pluginId": params.pluginId,
                    "toolName": params.toolName,
                }
            };

            resolve({
                content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        ok: false,
                        data: null,
                        error: errorDetail
                    }),
                },
                ],
            });
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
      }).catch((error) => {
        clearTimeout(timeout);
        wsManager.off("data-event", handler);
        reject(error);
      });
    });
  },
};
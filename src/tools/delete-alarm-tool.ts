// Delete Alarm tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY delete alarm tool - deletes existing alarms on user's device.
 * Requires entityId(s) from search_alarm or create_alarm tool as prerequisite.
 *
 * Prerequisites:
 * 1. Call search_alarm or create_alarm tool first to get entityId(s) of alarms
 * 2. Use the entityId(s) to delete those alarms
 *
 * Supports deleting single or multiple alarms in one call.
 */
export function createDeleteAlarmTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "delete_alarm",
  label: "Delete Alarm",
  description: `删除用户设备上的闹钟。使用前必须先调用 search_alarm 或 create_alarm 工具获取闹钟的 entityId。

使用示例：
- 删除单个闹钟：{"items": [{"entityId": "6"}]}
- 删除多个闹钟：{"items": [{"entityId": "6"}, {"entityId": "8"}]}

注意事项：
1. 操作超时时间为60秒，请勿重复调用此工具，如果超时或失败，最多重试一次。
2. 删除操作不可撤销，请确认 entityId 正确后再删除。
3. items 参数支持数组或 JSON 字符串格式，代码会自动解析。

回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。`,
  parameters: {
    type: "object",
    properties: {
      items: {
        // 不指定 type，允许传入数组或 JSON 字符串
        // 具体的类型验证和转换在 execute 函数内部进行
        description: "要删除的闹钟列表，每个元素包含 entityId 字段。支持数组或 JSON 字符串格式。entityId 是闹钟的唯一标识符（从 search_alarm 或 create_alarm 工具获取）。",
      },
    },
    required: ["items"],
  },

  async execute(toolCallId: string, params: any) {

    // ===== 参数规范化：兼容数组和 JSON 字符串 =====
    let items: Array<{ entityId: string }> | null = null;

    if (!params.items) {
      throw new Error("Missing required parameter: items");
    }

    // 情况1: 已经是数组
    if (Array.isArray(params.items)) {
      items = params.items;
    }
    // 情况2: 是字符串，尝试解析为 JSON 数组
    else if (typeof params.items === 'string') {
      try {
        const parsed = JSON.parse(params.items);
        if (Array.isArray(parsed)) {
          items = parsed;
        } else {
          throw new Error("items must be an array or a JSON string representing an array");
        }
      } catch (parseError) {
        throw new Error(`items must be a valid JSON array string. Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      }
    }
    // 情况3: 其他类型，报错
    else {
      throw new Error(`items must be an array or a JSON string, got ${typeof params.items}`);
    }

    // 验证数组非空
    if (!items || items.length === 0) {
      throw new Error("items array cannot be empty");
    }


    // 验证每个 item 是否有有效的 entityId
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item !== 'object') {
        throw new Error(`items[${i}] must be an object with entityId property`);
      }
      if (!item.entityId || typeof item.entityId !== 'string') {
        throw new Error(`items[${i}] must have a valid entityId string property`);
      }
    }


    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build DeleteAlarm command
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "DeleteAlarm",
          bundleName: "com.huawei.hmos.clock",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam: {
            items: items,
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
        reject(new Error("删除闹钟超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {

        if (event.intentName === "DeleteAlarm") {

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
            reject(new Error(`删除闹钟失败: ${event.status}`));
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

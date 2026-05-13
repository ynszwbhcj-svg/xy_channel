// XiaoYi GUI tool implementation - simulates phone screen interactions
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { getCurrentTaskId } from "../task-manager.js";
import { logger } from "../utils/logger.js";

/**
 * XiaoYi GUI tool - executes phone app interactions through GUI agent.
 * Simulates user interactions on phone screen (click, swipe, input, navigation, etc.)
 * to complete tasks that cannot be done through internet APIs.
 */
export function createXiaoyiGuiTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "xiaoyi_gui_agent",
  label: "XiaoYi GUI Agent",
  description: `通过模拟人在手机屏幕上的交互行为（点击、滑动、输入、页面导航等），自动完成手机APP中的各类任务。

该工具操作方式类似真实用户在手机上的操作，因此可以完成许多无法通过互联网API实现的任务，例如：
- 任务需要真实操作手机APP界面
- 数据仅存在于APP内部
- 无法通过互联网API获取数据
- 需要完成用户行为（签到、关注、购买等）
- 需要在APP中发布或发送内容
- 需要修改APP或手机设置

注意事项：
- 操作超时时间为3分钟（180秒）
- 该工具执行时间较长，请勿重复调用
- 该工具执行期间不要执行别的工具调用，必须等到该工具有结果返回或者超时之后才能执行别的操作，无论是新的文本回复还是下一步的工具调用，在此工具执行期间必须严格等待
- 如果超时或失败，最多重试一次
- 如果用户指令中包含备忘录读写，日程查看，不需要将这类操作放在gui tool的query参数中，需要使用预置的note相关工具与calendar相关工具完成相关操作`,

  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "操作手机的指令以及期望返回的结果。",
      },
    },
    required: ["query"],
  },

  async execute(toolCallId: string, params: any) {
    // Dynamic lookup: use latest taskId from task-manager (handles steer/interrupt)
    const currentTaskId = getCurrentTaskId(sessionId) ?? taskId;

    // Validate parameters
    if (!params.query || typeof params.query !== "string") {
      throw new Error("Missing or invalid required parameter: query must be a non-empty string");
    }

    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build InvokeJarvisGUIAgentRequest command
    const command = {
      header: {
        namespace: "ClawAgent",
        name: "InvokeJarvisGUIAgentRequest",
      },
      payload: {
        query: params.query,
        sessionId: sessionId,
        interactionId: currentTaskId, // taskId corresponds to interactionId; use dynamic lookup for steer safety
      },
    };


    // Send command and wait for response (5 minute timeout)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        wsManager.off("gui-agent-response", handler);
        reject(new Error("XiaoYi GUI Agent 操作超时（5分钟）"));
      }, 180000); // 5 minutes timeout

      // Listen for GUI agent response events
      const handler = (event: any) => {

        // Check if this is the InvokeJarvisGUIAgentResponse we're waiting for
        if (
          event.header?.namespace === "ClawAgent" &&
          event.header?.name === "InvokeJarvisGUIAgentResponse"
        ) {

          // According to the spec, we only get one response (isFinal: true)
          if (event.payload?.isFinal === true) {
            clearTimeout(timeout);
            wsManager.off("gui-agent-response", handler);

            const streamContent = event.payload?.streamInfo?.streamContent;

            if (streamContent) {

              resolve({
                content: [
                  {
                    type: "text",
                    text: streamContent,
                  }
                ]
              });
            } else {
              reject(new Error("XiaoYi GUI Agent 响应格式错误：缺少 streamContent"));
            }
          } else if (event.payload?.isFinal === false) {
            // According to spec, we shouldn't get intermediate responses, but log if we do
          }
        }
      };

      // Register event handler
      // Note: The WebSocket manager needs to emit 'gui-agent-response' when receiving this type of response
      wsManager.on("gui-agent-response", handler);

      // Send the command
      sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
      }).then(() => {
      }).catch((error) => {
        clearTimeout(timeout);
        wsManager.off("gui-agent-response", handler);
        reject(error);
      });
    });
  },
};
}

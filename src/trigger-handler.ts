// Trigger 事件处理器
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { A2AJsonRpcRequest } from "./types.js";
import { handleXYMessage } from "./bot.js";
import { logger } from "./utils/logger.js";

/**
 * Trigger 事件上下文
 */
export interface TriggerEventContext {
  event: any;           // Trigger 事件对象
  sessionId: string;    // 会话ID
  taskId: string;       // 任务ID（点击推送时生成的新ID）
}

/**
 * 处理 Trigger 事件
 * 当用户在手机侧点击推送消息时触发
 *
 * 策略：构造一个包含 Trigger 事件的 A2A 消息，通过 handleXYMessage 处理
 * 这样可以复用现有的消息链路和 runtime 初始化
 *
 * @param context - Trigger 事件上下文（包含 event, sessionId, taskId）
 * @param cfg - OpenClaw 配置
 * @param runtime - 运行时环境
 * @param accountId - 账号ID
 */
export async function handleTriggerEvent(
  context: TriggerEventContext,
  cfg: ClawdbotConfig,
  runtime: RuntimeEnv,
  accountId: string
): Promise<void> {

  try {
    const { event, sessionId, taskId } = context;

    logger.log(`[TRIGGER_HANDLER] Received Trigger event, sessionId: ${sessionId}, taskId: ${taskId}, pushDataId: ${event.payload?.dataMap?.pushDataId}`);

    // 构造包含 Trigger 事件的 A2A 消息
    // 将原始 event 放入 message.parts 中，让 handleXYMessage 检测并处理
    const a2aMessage: A2AJsonRpcRequest = {
      jsonrpc: "2.0",
      method: "sendMessage",
      id: taskId,
      params: {
        id: taskId,
        sessionId: sessionId,
        agentLoginSessionId: "",
        message: {
          role: "user",
          parts: [
            {
              kind: "data",
              data: {
                events: [event],  // 包含 Trigger 事件
              },
            },
          ],
        },
      },
    };

    logger.log(`[TRIGGER_HANDLER] Dispatching to handleXYMessage for processing`);

    // 通过 handleXYMessage 处理（复用现有链路）
    await handleXYMessage({
      cfg,
      runtime,
      message: a2aMessage,
      accountId,
    });

    logger.log(`[TRIGGER_HANDLER] Trigger event dispatched successfully`);
  } catch (err) {
    logger.error(`[TRIGGER_HANDLER] Failed to handle Trigger event:`, err);
  }
}

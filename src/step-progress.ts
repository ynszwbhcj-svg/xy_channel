// 对话 stepinfos 进度卡片下发
//
// 在 before_tool_call 钩子里向设备下发 UserInteraction 命令：
//   每次工具调用（非 final 帧）都配对下发两张卡：
//     1. DisplayTaskCardData：stepName 与工具卡 text 一致。
//     2. DisplayExecuteStatusCard：text = 「正在使用：xxx工具」。
//   不区分是否技能场景，所有使用到工具的场景都发配对标。
//
// 字段约定:
//   - taskUniqId = taskId 前两段（`${parts[0]}&${parts[1]}`），两张卡一致。
//   - index / taskUniqIndexId 是同一个字段：当前 turn 下发的第几个工具（从 1 起，
//     配对标共享同一序号）。
//   - isDisplayTaskCardData 恒为 true。
//   - turn 结束时（reply-dispatcher / subagent 终态路径）下发 DisplayTaskCardData
//     final 帧：isFinal=true、stepName 固定「已完成」、index = 最后一张卡 +1，
//     只发这一张（不发 DisplayExecuteStatusCard）；本轮没发过卡片则不发。
//
// 仅主会话对话路径生效：sessionKey 未绑定 A2A 身份的（cron/subagent）一律跳过。
// 钩子体全 try/catch：before_tool_call 抛错会 block 工具执行，卡片推送失败
// 绝不能影响工具本身。
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { sendCommand } from "./formatter.js";
import { resolveXYConfig } from "./config.js";
import {
  resolveBySessionKey,
  getCurrentTaskId,
  getCurrentMessageId,
  getCachedXYConfig,
} from "./conversation/conversation-manager.js";
import { resolveActualToolName } from "./utils/skill-path.js";
import { logger } from "./utils/logger.js";
import type { XYChannelConfig, A2ACommand } from "./types.js";

/** 工具级卡片图标（设备协议指定；需改时只动这里）。 */
const STEP_ICON_URL = "http://hivoice-drcn.dbankcdn.com/templatepic/Al_panels_80.svg";

/** 不发工具级卡片的工具：schema 查询、华为 id、agent-as-skill（自带设备 UI）。 */
function shouldSkipToolCard(innerName: string): boolean {
  return (
    innerName === "call_device_tool" ||
    innerName.endsWith("_tool_schema") ||
    innerName === "huawei_id_tool" ||
    innerName === "agent_as_a_tool"
  );
}

/** taskUniqId = taskId 前两段（uuid&interaction），不足两段时退化为整个 taskId。 */
function buildTaskUniqId(taskId: string): string {
  const parts = taskId.split("&");
  return parts.length >= 2 ? `${parts[0]}&${parts[1]}` : taskId;
}

// key: `${sessionId}|${taskId}` → 本轮下一个可用的卡片序号（从 1 起）。
// 模块级存放，供 before_tool_call 钩子与 turn 结束的 final 帧共用。
const turnNextIndex = new Map<string, number>();

/** 取本轮下一个序号并自增；极端情况下整体清空防泄漏（代价只是序号重排）。 */
function takeNextIndex(sessionId: string, taskId: string): number {
  const key = `${sessionId}|${taskId}`;
  const next = turnNextIndex.get(key) ?? 1;
  turnNextIndex.set(key, next + 1);
  if (turnNextIndex.size > 1000) turnNextIndex.clear();
  return next;
}

function buildTaskCard(taskUniqId: string, index: number, text: string, isFinal: boolean): A2ACommand {
  return {
    header: { namespace: "UserInteraction", name: "DisplayTaskCardData" },
    payload: {
      isFinal,
      taskUniqId,
      stepName: text,
      index,
      isDisplayTaskCardData: true,
      taskUniqIndexId: index,
    },
  };
}

function buildToolCard(taskUniqId: string, index: number, text: string): A2ACommand {
  return {
    header: { namespace: "UserInteraction", name: "DisplayExecuteStatusCard" },
    payload: {
      icon: STEP_ICON_URL,
      text,
      isFinal: false,
      taskUniqId,
      taskUniqIndexId: index,
    },
  };
}

/**
 * Turn 结束收口:下发 DisplayTaskCardData final 帧（stepName 固定「已完成」）。
 * 仅当本轮至少发过一张卡片时真正下发；由 reply-dispatcher onIdle 与
 * subagent 终态路径（deliverSubagentFinalResult）调用。
 */
export async function sendTurnFinalStepCard(params: {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
}): Promise<void> {
  try {
    const key = `${params.sessionId}|${params.taskId}`;
    const next = turnNextIndex.get(key);
    // next === 1 表示本轮一张卡都没发过（序号从 1 起未被消费）→ 不发 final
    if (next === undefined || next <= 1) return;
    turnNextIndex.delete(key);

    const taskUniqId = buildTaskUniqId(params.taskId);
    // index = 最后一张卡的序号 +1（next 即为最后序号的下一位）
    const command = buildTaskCard(taskUniqId, next, "已完成", true);
    await sendCommand({
      config: params.config,
      sessionId: params.sessionId,
      taskId: params.taskId,
      messageId: params.messageId,
      command,
    });
    logger.log(`[STEP-PROGRESS] Sent turn final card, index=${next}`);
  } catch (err) {
    logger.error(`[STEP-PROGRESS] Failed to send turn final card:`, err);
  }
}

/**
 * Register the step-progress hook: pushes tool-level progress cards on every
 * tool call, plus a paired skill-level card when a SKILL.md is read.
 */
export function registerStepProgressHook(api: OpenClawPluginApi): void {
  // 优先用每消息缓存的已解析 config；兜底 resolveXYConfig(api.config)。
  // 失败返回 null（配置缺失时静默跳过，绝不向外抛）。
  const getConfig = (): XYChannelConfig | null => {
    try {
      const cached = getCachedXYConfig();
      if (cached) return cached as XYChannelConfig;
      return resolveXYConfig(api.config);
    } catch (err) {
      logger.error(`[STEP-PROGRESS] Failed to resolve channel config:`, err);
      return null;
    }
  };

  // sessionKey → A2A 身份。未绑定的（cron/subagent）返回 null 跳过。
  // steer 场景 taskId/messageId 以任务链尾部为准。
  const resolveIds = (sessionKey: string | undefined) => {
    const binding = resolveBySessionKey(sessionKey ?? "");
    if (!binding) return null;
    const taskId = getCurrentTaskId(binding.sessionId) ?? binding.taskId;
    const messageId = getCurrentMessageId(binding.sessionId) ?? binding.messageId;
    return {
      sessionId: binding.sessionId,
      taskId,
      messageId,
      taskUniqId: buildTaskUniqId(taskId),
    };
  };

  interface StepIds {
    sessionId: string;
    taskId: string;
    messageId: string;
    taskUniqId: string;
  }

  api.on("before_tool_call", async (event, ctx) => {
    try {
      const config = getConfig();
      if (!config) return;
      const ids = resolveIds(ctx.sessionKey);
      if (!ids) return;

      const innerName = resolveActualToolName(event);
      if (shouldSkipToolCard(innerName)) return;

      // 所有使用到工具的场景都下发配对标（不区分技能场景），
      // stepName 与 text 保持一致、共享同一序号。
      const text = `正在使用：${innerName}`;
      const index = takeNextIndex(ids.sessionId, ids.taskId);

      const commands: A2ACommand[] = [
        buildTaskCard(ids.taskUniqId, index, text, false),
        buildToolCard(ids.taskUniqId, index, text),
      ];

      await sendCommand({
        config,
        sessionId: ids.sessionId,
        taskId: ids.taskId,
        messageId: ids.messageId,
        commands,
        toolCallId: event.toolCallId,
      });
    } catch (err) {
      // 卡片推送失败绝不能 block 工具执行
      logger.error(`[STEP-PROGRESS] before_tool_call card push failed:`, err);
    }
  });
}

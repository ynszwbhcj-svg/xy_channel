// Outbound gateway — 对话管理层的出站网关。
// 本模块是唯一允许 import transport/* 的模块：所有发往 xy server 的出站消息
// （WebSocket A2A 帧 + HTTP push）都必须经过这里，形成物理收口点。
//
// 依赖方向：formatter / dispatch → conversation/outbound-gateway → transport/*

import os from "os";
import { randomUUID } from "crypto";
import { getXYWebSocketManager } from "../transport/client.js";
import { XYPushService } from "../transport/push.js";
import { getAllPushIds } from "../utils/pushid-manager.js";
import { logger } from "../utils/logger.js";
import type {
  XYChannelConfig,
  OutboundWebSocketMessage,
  A2ACommand,
} from "../types.js";

// ─── WebSocket A2A 帧发送 ─────────────────────────────────────

export interface SendWsFrameParams {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  /** JSON-RPC response body（hostname 由网关统一附加）。 */
  payload: Record<string, any>;
}

/** 从 artifact parts 中提取内嵌的 A2ACommand 列表（data part 的 commands 字段）。 */
function extractCommands(payload: Record<string, any>): A2ACommand[] {
  const parts = payload?.result?.artifact?.parts;
  if (!Array.isArray(parts)) return [];
  return parts
    .filter((p: any) => p?.kind === "data" && Array.isArray(p.data?.commands))
    .flatMap((p: any) => p.data.commands);
}

function isMemoryFileReadCommand(command: A2ACommand): boolean {
  return command?.header?.namespace === "AgentEvent"
    && command?.header?.name === "MemoryQuery"
    && command?.payload?.action === "MemoryFileRead";
}

/**
 * 发送一帧 A2A agent_response 到 xy server。
 * 统一封装 OutboundWebSocketMessage 信封（msgType/agentId/hostname）。
 */
export async function sendWsFrame(params: SendWsFrameParams): Promise<void> {
  const { config, sessionId, taskId, payload } = params;
  const wsManager = getXYWebSocketManager(config);
  const outboundMessage: OutboundWebSocketMessage = {
    msgType: "agent_response",
    agentId: config.agentId,
    sessionId,
    taskId,
    msgDetail: JSON.stringify({ ...payload, hostname: os.hostname() }),
  };
  // 完整出站 A2A 日志：信封摘要 + msgDetail 全量 + 内嵌 command 单独打印。
  // MemoryFileRead 必须原样传输文件正文，因此仅记录响应元数据，避免正文进入日志。
  const log = logger.withContext(sessionId, taskId);
  log.log(
    `[A2A-OUT] msgType=${outboundMessage.msgType}, agentId=${outboundMessage.agentId}, sessionId=${sessionId}, taskId=${taskId}, size=${outboundMessage.msgDetail.length}`,
  );
  const commands = extractCommands(payload);
  const memoryFileReadCommands = commands.filter(isMemoryFileReadCommand);
  if (memoryFileReadCommands.length > 0) {
    for (const command of memoryFileReadCommands) {
      const ans = command.payload?.ans;
      const contentBytes = Number.isSafeInteger(ans?.contentBytes) ? ans.contentBytes : "none";
      const errorCode = typeof ans?.errorCode === "string" ? ans.errorCode : "none";
      log.log(
        `[A2A-OUT] command action=MemoryFileRead, ok=${ans?.ok === true}, contentBytes=${contentBytes}, errorCode=${errorCode}`,
      );
    }
  } else {
    log.log(`[A2A-OUT] msgDetail=${outboundMessage.msgDetail}`);
    if (commands.length > 0) {
      log.log(`[A2A-OUT] commands=${JSON.stringify(commands)}`);
    }
  }
  await wsManager.sendMessage(sessionId, outboundMessage);
}

// ─── HTTP push 发送 ───────────────────────────────────────────

export interface PushBroadcastParams {
  config: XYChannelConfig;
  text: string;
  title: string;
  /** 目标会话标识（push 服务侧使用，可为空字符串）。 */
  to: string;
  pushDataId: string;
  /** cron 推送时携带：任务 jobId（随 kind="data" 下发给客户端） */
  cronJobId?: string;
  /** cron 推送时携带：任务标题 */
  cronTitle?: string;
}

export interface PushBroadcastResult {
  successCount: number;
  failureCount: number;
}

/**
 * 向所有已注册 pushId 广播推送通知（单 pushId 失败不影响其他）。
 */
export async function pushBroadcast(params: PushBroadcastParams): Promise<PushBroadcastResult> {
  const { config, text, title, to, pushDataId, cronJobId, cronTitle } = params;

  let pushIdList: string[] = [];
  try {
    pushIdList = await getAllPushIds();
  } catch (error) {
    logger.error(`[outbound-gateway] Failed to load pushIds:`, error);
  }
  if (pushIdList.length === 0) {
    pushIdList = [String(config.pushId)];
  }

  const pushService = new XYPushService(config);
  let successCount = 0;
  let failureCount = 0;

  for (const pushId of pushIdList) {
    try {
      await pushService.sendPush(text, title, undefined, to, pushDataId, pushId, cronJobId, cronTitle);
      successCount++;
      logger.log(`[outbound-gateway] Push sent to pushId: ${pushId.substring(0, 20)}...`);
    } catch (error) {
      failureCount++;
      logger.error(`[outbound-gateway] Failed to send to pushId: ${pushId.substring(0, 20)}...`, error);
    }
  }

  return { successCount, failureCount };
}

export interface PushCommandParams {
  config: XYChannelConfig;
  command: A2ACommand;
  /** 指定设备的 pushId（多设备路由）。未传时回退到 getAllPushIds()[0]。 */
  pushId?: string;
}

/**
 * 通过 push 通道下发工具指令（cron 触发的工具调用无活跃 WS 会话时使用）。
 */
export async function pushCommand(params: PushCommandParams): Promise<void> {
  const { config, command } = params;

  let pushId: string = config.pushId;
  if (params.pushId) {
    pushId = params.pushId;
  } else {
    try {
      const pushIdList = await getAllPushIds();
      if (pushIdList.length > 0) {
        pushId = pushIdList[0];
      }
    } catch (error) {
      logger.error("[outbound-gateway] Failed to load pushIds:", error);
    }
  }

  const pushService = new XYPushService(config);
  logger.log(`[A2A-OUT] push command, pushId=${pushId.substring(0, 20)}..., command=${JSON.stringify(command)}`);
  await pushService.sendPushWithDirectives(pushId, randomUUID(), [command]);
}

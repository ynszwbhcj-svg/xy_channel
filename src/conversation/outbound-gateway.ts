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
}

export interface PushBroadcastResult {
  successCount: number;
  failureCount: number;
}

/**
 * 向所有已注册 pushId 广播推送通知（单 pushId 失败不影响其他）。
 */
export async function pushBroadcast(params: PushBroadcastParams): Promise<PushBroadcastResult> {
  const { config, text, title, to, pushDataId } = params;

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
      await pushService.sendPush(text, title, undefined, to, pushDataId, pushId);
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
  await pushService.sendPushWithDirectives(pushId, randomUUID(), [command]);
}

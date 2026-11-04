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
import { getOrCreateConvId } from "../utils/cron-conv-map.js";
import { recordSentStreamingTextId } from "../utils/streaming-text-id.js";
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

/**
 * 将混合携带 reasoningText 与 text 的 artifact-update 帧拆分为两帧
 * （reasoning 帧在前、正文帧在后，保持原有相对时序）；非混合帧原样返回
 * （单元素数组）。
 *
 * 协议约束：reasoningText 与正文 text 禁止同帧携带。当前上游组帧
 * （formatter.sendA2AResponse / sendReasoningTextUpdate）天然分离两类 part，
 * 本拆分是物理收口点的防御性兜底，命中说明上游出现了回归。
 */
function splitMixedReasoningFrames(payload: Record<string, any>): Array<Record<string, any>> {
  const result = payload?.result;
  const parts = result?.artifact?.parts;
  if (!Array.isArray(parts) || parts.length < 2) return [payload];
  const hasReasoning = parts.some((p: any) => p?.kind === "reasoningText");
  const hasText = parts.some((p: any) => p?.kind === "text");
  if (!hasReasoning || !hasText) return [payload];

  logger.warn(`[A2A-OUT] Mixed reasoningText+text frame detected, splitting into separate frames`);
  const reasoningParts = parts.filter((p: any) => p?.kind === "reasoningText");
  const otherParts = parts.filter((p: any) => p?.kind !== "reasoningText");
  const reasoningFrame = {
    ...payload,
    result: {
      ...result,
      // reasoning 帧后面还跟着正文帧，不再是末帧
      lastChunk: false,
      final: false,
      artifact: { ...result.artifact, parts: reasoningParts },
    },
  };
  const textFrame = {
    ...payload,
    result: { ...result, artifact: { ...result.artifact, parts: otherParts } },
  };
  return [reasoningFrame, textFrame];
}

/**
 * 发送一帧 A2A agent_response 到 xy server。
 * 统一封装 OutboundWebSocketMessage 信封（msgType/agentId/hostname）。
 */
export async function sendWsFrame(params: SendWsFrameParams): Promise<void> {
  const { config, sessionId, taskId, payload } = params;
  const wsManager = getXYWebSocketManager(config);
  const log = logger.withContext(sessionId, taskId);

  for (const frame of splitMixedReasoningFrames(payload)) {
    const outboundMessage: OutboundWebSocketMessage = {
      msgType: "agent_response",
      agentId: config.agentId,
      sessionId,
      taskId,
      msgDetail: JSON.stringify({ ...frame, hostname: os.hostname() }),
    };
    // 完整出站 A2A 日志：每一帧都打印信封摘要 + msgDetail 全量 + 内嵌 command
    // 单独打印（内容字段已在组帧时脱敏，日志不会额外泄露敏感信息）
    log.log(
      `[A2A-OUT] msgType=${outboundMessage.msgType}, agentId=${outboundMessage.agentId}, sessionId=${sessionId}, taskId=${taskId}, size=${outboundMessage.msgDetail.length}`,
    );
    log.log(`[A2A-OUT] msgDetail=${outboundMessage.msgDetail}`);
    const commands = extractCommands(frame);
    if (commands.length > 0) {
      log.log(`[A2A-OUT] commands=${JSON.stringify(commands)}`);
    }
    await wsManager.sendMessage(sessionId, outboundMessage);
    // 帧已实际上送：登记"最后一帧 artifact-update 的 streamingTextId"。
    // command 帧据此对齐端侧最后收到的 id（不允许引入新 id，见
    // utils/streaming-text-id）。status-update 旁路帧不参与登记。
    const result = frame?.result;
    if (result?.kind === "artifact-update" && typeof result.streamingTextId === "string") {
      recordSentStreamingTextId(taskId, result.streamingTextId);
    }
  }
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
 * 生成 syncInteractionId（48 位）：`00` + 13 位毫秒时间戳 + `_` + 32 位 UUID（去连字符）。
 * 前 15 位时间戳段定长 → 字典序即时间序，天然支持方向分页（> / <）、增量拉取、取最新一条。
 */
export function generateSyncInteractionId(): string {
  return `00${Date.now()}_${randomUUID().replace(/-/g, "")}`;
}

/**
 * 向所有已注册 pushId 广播推送通知（单 pushId 失败不影响其他）。
 *
 * cron 推送（带 cronJobId）时：
 * - 在此解析 convId：cronId↔convId 一一映射持久化于 cron-conv-map.json，
 *   首次命中自动生成 16 位随机 convId 落盘，之后同一 cronId 复用；解析失败
 *   不阻塞 push（convId 缺省不下发）。
 * - 整个广播生成一个 syncInteractionId（00+13位毫秒时间戳+_+32位UUID，48 位，
 *   字典序即时间序），随 kind="data" 下发给所有设备且保持一致，作为客户端
 *   多设备消息同步的对齐锚点。
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

  // cron 推送：解析 convId（无映射则生成并持久化）
  let convId: string | undefined;
  if (cronJobId) {
    try {
      convId = (await getOrCreateConvId(cronJobId)) ?? undefined;
    } catch (error) {
      logger.error(`[outbound-gateway] Failed to resolve convId for cronId=${cronJobId}:`, error);
    }
  }

  // cron 推送：整个广播只生成一个 syncInteractionId，保证所有设备收到的 push 一致
  // （客户端多设备消息同步的对齐锚点）；非 cron 推送不下发该字段。
  const syncInteractionId = cronJobId ? generateSyncInteractionId() : undefined;

  const pushService = new XYPushService(config);
  let successCount = 0;
  let failureCount = 0;

  for (const pushId of pushIdList) {
    try {
      await pushService.sendPush(text, title, undefined, to, pushDataId, pushId, cronJobId, cronTitle, convId, syncInteractionId);
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

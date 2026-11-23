import type { XYChannelConfig, A2ACommand } from "../types.js";
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
export declare function sendWsFrame(params: SendWsFrameParams): Promise<void>;
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
export declare function generateSyncInteractionId(): string;
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
export declare function pushBroadcast(params: PushBroadcastParams): Promise<PushBroadcastResult>;
export interface PushCommandParams {
    config: XYChannelConfig;
    command: A2ACommand;
    /** 指定设备的 pushId（多设备路由）。未传时回退到 getAllPushIds()[0]。 */
    pushId?: string;
}
/**
 * 通过 push 通道下发工具指令（cron 触发的工具调用无活跃 WS 会话时使用）。
 */
export declare function pushCommand(params: PushCommandParams): Promise<void>;

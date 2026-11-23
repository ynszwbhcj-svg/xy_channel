import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
/**
 * Trigger 事件上下文
 */
export interface TriggerEventContext {
    event: any;
    sessionId: string;
    taskId: string;
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
export declare function handleTriggerEvent(context: TriggerEventContext, cfg: ClawdbotConfig, runtime: RuntimeEnv, accountId: string): Promise<void>;

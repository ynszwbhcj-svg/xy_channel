import type { XYChannelConfig } from "../types.js";
/** 随 push 下发的 cron 元数据（jobId + title），客户端据此识别 push 来源。 */
export interface CronTurnMeta {
    jobId?: string;
    jobTitle?: string;
}
/**
 * 收集 openclaw assistant 流事件。data.text 在同一消息内是累计文本，下一条
 * assistant 消息会重新从头开始；replace=true 表示同一消息的权威替换帧。
 * sessionKey 已在 index.ts 中解析成 jobId，因此并发 cron 不会串文本。
 */
export declare function captureCronAssistantText(jobId: string | undefined, text: string | undefined, replace?: boolean): void;
/** 关闭指定 job 的 cron turn（清理全部定时器）。 */
export declare function closeCronTurn(jobId: string | undefined, reason: string): void;
/**
 * cron turn 开始检测。由 provider.ts 在识别到 [cron:...] 首条消息时调用。
 * 同一 cron run 的每次模型调用都会重复触发检测 —— 此时仅刷新安全定时器，
 * 不重开 turn（避免 churn，也避免重置 agentEnded/缓冲状态）。
 * 按 jobId 隔离：不同 job 并发触发时各自独立建 turn，后到 job 的 jobId
 * 不再被覆盖丢弃。
 */
export declare function notifyCronDetected(jobId?: string, jobTitle?: string): void;
/**
 * cron run 结束信号（lifecycle phase=end，由 index.ts 的 agent event
 * subscription 调用，jobId 从 event.sessionKey 解析）。只结束该 job 的
 * turn，进入 announce 宽限期：
 *   - 宽限期内 announce 到达 → 放行（见 gateCronSendText）；
 *   - 宽限期结束无 announce → 合并缓冲文本发一条（路径 B）。
 * jobId 缺失（sessionKey 解析失败）时：若恰有 1 个活跃 turn，兼容旧单槽
 * 行为结束之；多个活跃 turn 时无法归属，跳过并告警。
 */
export declare function notifyCronAgentEnd(jobId?: string): void;
export type CronSendTextGate = "swallow" | "announce" | "none";
export interface CronGateResult {
    gate: CronSendTextGate;
    /** gate === "announce" 时应实际保存/推送的去重合并全文。 */
    text?: string;
    /**
     * gate === "announce" 时的 cron 元数据同步快照（其余情况为 null）。
     * 快照在 gate 返回时完成 —— 调用方后续 await 空窗期内 turn 可能被
     * safety timer 关闭，届时再读 turn 已拿不到 meta。
     */
    meta: CronTurnMeta | null;
    /** 本次 sendText 归属的 cron jobId（调用方据此精确关闭 turn）。 */
    jobId?: string;
}
/**
 * 判断 sendText 的 to 是否为 cron announce 占位目标。
 *
 * 背景：openclaw cron announce 的 to 由任务 delivery 配置决定，可能是空串、
 * "default"（DEFAULT_PUSH_MARKER）或 "00000000" 等占位符，并不统一。真实对话
 * 的 message 工具 target 经 resolveTarget 增强后必为 "sessionId::taskId" 格式，
 * 含 "::"。
 *
 * 路由规则：
 *   - to 为空：必为 announce；
 *   - to 含 "::"：必为真实对话 target，不是 announce；
 *   - 其余占位符（"default"/"00000000"/...）：仅当 registry 中存在 agentEnded
 *     的 cron turn 时才视为 announce —— run 结束后 openclaw 只会发一条
 *     announce sendText；run 期间的同 target sendText 仍是中间消息，应走
 *     swallow 分支。普通对话 registry 无 cron turn，此判定自然返回 false，
 *     行为与改动前一致。
 */
export declare function isCronAnnounceTarget(to: string | undefined): boolean;
/**
 * sendText 闸门。sendText 层拿不到 jobId/runId，只能凭 announceLike
 * （to 是否为 DEFAULT_PUSH_MARKER，即是否有显式 target）做粗路由：
 * - announceLike（无 target）：run 结束后的 announce 最终结果，路由到处于
 *   agentEnded 宽限的 turn。多个 ended turn（两端几乎同时结束的窄竞态）按
 *   endedAt FIFO，与 openclaw 按 run 完成顺序投递 announce 一致。
 * - 非 announceLike（有 target）：run 期间的中间 sendText，吞入活跃 turn
 *   缓冲。恰 1 个活跃 turn 正常吞；多活跃 turn（真并发、无法归属）安全回退
 *   返回 "none"（不聚合、原样发送，宁可多推也不让 pushText/cronId 串台）。
 * - "none"：无 cron turn 或无法归属，按普通 push 发送。
 */
export declare function gateCronSendText(swallowedText: string | undefined, announceLike: boolean, config?: XYChannelConfig): CronGateResult;

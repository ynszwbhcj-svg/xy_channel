export type SteerSource = "user" | "cspl";
export type SteerResult = {
    ok: true;
    mode: "direct";
} | {
    ok: false;
    reason: "no-session" | "no-active-run" | "queue-rejected";
};
export interface SteerParams {
    sessionId: string;
    text: string;
    source: SteerSource;
    /**
     * 可选：调用方已解析的 openclaw sessionKey（bot.ts 的 route.sessionKey，
     * 可能经过 ACP binding 调整）。未提供时回退到对话管理层绑定的 sessionKey。
     */
    sessionKey?: string;
}
/**
 * 尝试将 steer 文本直接注入当前会话的活跃 embedded run。
 * 不做任何兜底 —— 失败策略由调用方决定。
 */
export declare function tryDirectSteer(params: SteerParams): SteerResult;
/**
 * 对话管理层 steer 入口。
 * - user：直接注入失败时返回失败，由 bot.ts 落回普通派发（新 turn）。
 * - cspl：直接注入失败即失败，仅记录日志，不兜底。
 */
export declare function steer(sessionId: string, text: string, source: SteerSource): Promise<SteerResult>;

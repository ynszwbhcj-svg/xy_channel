import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { A2AJsonRpcRequest } from "../types.js";
/**
 * Parameters for handling an XY message.
 */
export interface HandleXYMessageParams {
    cfg: ClawdbotConfig;
    runtime: RuntimeEnv;
    message: A2AJsonRpcRequest;
    accountId: string;
    webSocketSessionId?: string;
    /** 在实际 dispatch 初始化前获取全局门，初始化完成后释放。 */
    acquireDispatchInitGate?: () => Promise<() => void>;
    /** steer 回退前等待同 session 的旧 dispatch 收尾，避免并发争用会话写锁。 */
    waitForPreviousTurn?: () => Promise<void>;
    /** Attachments/model changes must enter a complete turn instead of text-only steer. */
    forceNewTurn?: boolean;
    /** Commit the monitor's model snapshot only after this complete turn is admitted. */
    onTurnAdmitted?: () => void;
}
/**
 * Handle an incoming A2A message.
 * This is the main entry point for message processing.
 * Runtime is expected to be validated before calling this function.
 */
export declare function handleXYMessage(params: HandleXYMessageParams): Promise<void>;

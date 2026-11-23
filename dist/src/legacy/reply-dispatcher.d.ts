import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
export interface CreateXYReplyDispatcherParams {
    cfg: ClawdbotConfig;
    runtime: RuntimeEnv;
    sessionId: string;
    taskId: string;
    messageId: string;
    accountId: string;
    /** Called at end of onIdle, after final frame is sent. openclaw's waitForIdle() does
     *  not await the async onIdle, so cleanup must happen inside onIdle itself. */
    onIdleComplete?: () => void | Promise<void>;
}
/**
 * 清理 /tmp/xy_channel 目录中超过 24 小时的旧文件
 */
export declare function cleanupStaleTempFiles(tempDir?: string): Promise<void>;
/**
 * Create a reply dispatcher for XY channel messages.
 * Follows feishu pattern with status updates and streaming support.
 * Runtime is expected to be validated before calling this function.
 */
export declare function createLegacyReplyDispatcher(params: CreateXYReplyDispatcherParams): any;

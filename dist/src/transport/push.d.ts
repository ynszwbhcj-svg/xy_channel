import type { XYChannelConfig } from "../types.js";
/**
 * Service for sending push messages to users.
 * Used for outbound messages and scheduled tasks.
 */
export declare class XYPushService {
    private config;
    private readonly PROD_PUSH_URL;
    private readonly TEST_PUSH_URL;
    private readonly REQUEST_FROM;
    constructor(config: XYChannelConfig);
    /**
     * Resolve push URL: config.pushUrl > inferred from fileUploadUrl > production default.
     */
    private resolvePushUrl;
    /**
     * Generate a random trace ID for request tracking.
     */
    private generateTraceId;
    /**
     * Send a push message to a user session.
     *
     * @param content - Push message content
     * @param title - Push message title
     * @param data - Optional additional data
     * @param sessionId - Optional session ID
     * @param pushDataId - Optional pushDataId for kind="data" format
     * @param pushId - Push ID to use (required)
     * @param cronJobId - Optional cron job ID（仅 cron 推送，随 kind="data" 下发，线上字段名 cronId）
     * @param cronTitle - Optional cron job 标题（仅 cron 推送，随 kind="data" 下发）
     * @param convId - Optional 与 cronId 一一映射的会话标识（仅 cron 推送，随 kind="data" 下发）
     * @param syncInteractionId - Optional 多端同步交互标识（仅 cron 推送，由广播方生成一次，同一广播内所有设备一致）
     */
    sendPush(content: string, title: string, data?: Record<string, any>, sessionId?: string, pushDataId?: string, pushId?: string, cronJobId?: string, cronTitle?: string, convId?: string, syncInteractionId?: string): Promise<void>;
    /**
     * Send a push message with command directives embedded directly.
     * Used for cron-triggered commands where pushText is empty and pushType=101.
     */
    sendPushWithDirectives(pushId: string, sessionId: string, directives: any[]): Promise<void>;
    /**
     * Send a push message with file attachments.
     */
    sendPushWithFiles(content: string, title: string, fileIds: string[], sessionId?: string): Promise<void>;
}

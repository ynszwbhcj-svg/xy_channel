/** cron_changed 事件的最小结构（只取同步所需字段，避免依赖 SDK 内部类型导出）。 */
interface CronChangedLike {
    action?: string;
    jobId?: string;
    job?: {
        enabled?: boolean;
        schedule?: unknown;
    };
}
/**
 * cron_changed 钩子触发时同步定时任务变更到云端。
 * 不抛异常 —— 失败只记日志。
 */
export declare function syncScheduledTaskOnCronChanged(event: CronChangedLike): Promise<void>;
export {};

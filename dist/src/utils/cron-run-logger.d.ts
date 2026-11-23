/** 一次定时任务执行的日志字段（缺失字段落 null，保持 schema 稳定）。 */
export interface CronRunLogFields {
    jobId: string;
    name: string | null;
    /** 任务创建时间（取自 job 快照 createdAtMs） */
    createdAtMs: number | null;
    /** 当前执行是否成功：ok / error / skipped */
    status: string | null;
    durationMs: number | null;
    runAtMs: number | null;
    nextRunMs: number | null;
    sessionId: string | null;
    model: string | null;
    /** 失败原因；执行成功/无报错时为 null */
    error: string | null;
}
/**
 * Write one cron-run record to the cron log.
 * Format: |YYYYMMDDThhmmss|{json}
 * 写日志失败静默吞掉 —— 绝不影响 cron hook 主链路。
 */
export declare function writeCronRunLog(fields: CronRunLogFields): void;

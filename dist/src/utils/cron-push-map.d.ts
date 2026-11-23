/** 映射来源，区分两种创建路径。 */
export type CronPushMapSource = "conversation" | "cron-query" | "exec-cli";
export interface CronPushMapEntry {
    pushId: string;
    /** 创建该 cron 时的 xy sessionId，便于同进程兜底。 */
    sessionId?: string;
    /** 冗余记录设备类型，fire 时可按设备类型做差异化处理。 */
    deviceType?: string;
    source?: CronPushMapSource;
    createdAt: number;
}
export interface CronPushMapFile {
    version: 1;
    entries: Record<string, CronPushMapEntry>;
}
/** 写入/更新一条 jobId → pushId 映射。 */
export declare function setJobPushId(jobId: string, entry: Omit<CronPushMapEntry, "createdAt">): Promise<void>;
/** fire 时主查询：按 jobId 取 pushId。 */
export declare function getPushIdByJobId(jobId: string): Promise<{
    pushId: string;
    entry: CronPushMapEntry;
} | null>;
/** 删除一条映射（cron job 被移除时清理）。 */
export declare function removeJob(jobId: string): Promise<void>;
/** 对账：删除 openclaw 里已不存在的 job，避免映射无限增长。 */
export declare function pruneStale(existingJobIds: Set<string>): Promise<void>;

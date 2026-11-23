/**
 * 推送数据项
 */
export interface PushDataItem {
    pushDataId: string;
    dataDetail: string;
    time: string;
    /** cron 推送时携带：任务 jobId（正常对话推送无此字段） */
    cronJobId?: string;
    /** cron 推送时携带：任务标题（openclaw job.name） */
    cronTitle?: string;
}
/**
 * 保存推送数据，返回 pushDataId
 * meta.cronJobId/cronTitle 仅 cron 推送时传入（正常对话为 undefined，不写入文件）。
 */
export declare function savePushData(dataDetail: string, meta?: {
    cronJobId?: string;
    cronTitle?: string;
}): Promise<string>;
/**
 * 根据 pushDataId 获取推送数据
 */
export declare function getPushDataById(pushDataId: string): Promise<PushDataItem | null>;
/**
 * 搜索推送数据（支持关键词模糊匹配）
 */
export declare function searchPushData(keywords?: string): Promise<PushDataItem[]>;
/**
 * 获取所有推送数据
 */
export declare function getAllPushData(): Promise<PushDataItem[]>;
/**
 * 清空所有推送数据（用于测试或重置）
 */
export declare function clearAllPushData(): Promise<void>;

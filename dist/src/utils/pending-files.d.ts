/** 待下发文件条目（上传已完成，fileId/fileUrl 在工具调用点就绪）。 */
export interface PendingFileItem {
    fileName: string;
    /** MIME 类型（跨设备回传的文件卡片可能缺失，帧内不携带）。 */
    mimeType?: string;
    fileId: string;
    /** 公网 URL（跨设备回传的文件卡片可能只有 fileId，无 URL）。 */
    fileUrl?: string;
}
/** 攒批待下发文件（工具调用点调用）。同一 turn 多次调用累加到同一列表。 */
export declare function appendPendingFiles(taskId: string, items: PendingFileItem[]): void;
/** 读取并清空待下发文件（收尾序列 flush 时调用）；无待下发返回空数组。 */
export declare function drainPendingFiles(taskId: string): PendingFileItem[];
/** 释放指定 taskId 的待下发文件（任务链清理 / 会话销毁时调用）。幂等。 */
export declare function releasePendingFiles(taskId: string): void;

export interface CronConvMapEntry {
    convId: string;
    createdAt: number;
    /** 最近一次轮换时间（首次创建时与 createdAt 相同）。 */
    updatedAt: number;
}
export interface CronConvMapFile {
    version: 1;
    entries: Record<string, CronConvMapEntry>;
}
/** 生成 16 位随机 convId（8 字节随机数的 hex 编码，恰 16 个字符）。 */
export declare function generateConvId(): string;
/**
 * 按 cronId 取 convId：已有映射直接返回；无映射则生成 16 位随机 convId
 * 并持久化（首次建立映射）。失败时返回 null，不抛出，避免阻塞 push 主流程。
 */
export declare function getOrCreateConvId(cronId: string): Promise<string | null>;
/**
 * 强制轮换 convId（UpdateTaskConvId 事件）：无论原映射是否存在，
 * 都生成一个新的 16 位 convId 覆盖旧映射并持久化。
 * 失败时返回 null，不抛出，避免影响事件响应。
 */
export declare function regenerateConvId(cronId: string): Promise<string | null>;

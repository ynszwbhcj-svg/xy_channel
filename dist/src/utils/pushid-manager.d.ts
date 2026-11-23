/**
 * 添加新的 pushId（去重）
 */
export declare function addPushId(pushId: string): Promise<void>;
/**
 * 获取所有 pushId
 */
export declare function getAllPushIds(): Promise<string[]>;
/**
 * 清空所有 pushId（用于测试或重置）
 */
export declare function clearAllPushIds(): Promise<void>;

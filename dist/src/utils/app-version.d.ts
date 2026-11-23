/** 逐段数值比较：appVer 低于阈值返回 true；等于或高于返回 false。 */
export declare function isBelowLegacyAppVersion(appVer: string): boolean;
/** 消息入口标记本 taskId 的 App 版本（appVer 缺失时不标记，保持默认）。 */
export declare function markAppVersion(taskId: string, appVer: string | null | undefined): void;
/** 查询指定 taskId 是否低版本（默认 false）。 */
export declare function isLegacyAppVersion(taskId: string): boolean;
/** 释放指定 taskId 的版本标记（turn 结束 / 会话销毁时调用）。幂等。 */
export declare function releaseAppVersion(taskId: string): void;

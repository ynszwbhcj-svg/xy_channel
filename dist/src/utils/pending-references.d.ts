import type { ReferenceDataItem } from "../formatter.js";
/** 攒批引用条目（工具调用点调用）。同一 turn 多次调用累加到同一列表。 */
export declare function appendPendingReferences(taskId: string, items: ReferenceDataItem[]): void;
/** 读取并清空待下发引用（收尾序列 flush 时调用）；无待下发返回空数组。 */
export declare function drainPendingReferences(taskId: string): ReferenceDataItem[];
/** 释放指定 taskId 的待下发引用（任务链清理 / 会话销毁时调用）。幂等。 */
export declare function releasePendingReferences(taskId: string): void;

export interface OutboundFrame {
    /** 帧归属的 taskId（purge 的粒度）。 */
    taskId: string;
    /** 日志标签（帧用途描述）。 */
    label: string;
    /**
     * 合并键：drain 取帧时，若队列后方存在同 key 帧，则跳过本帧。
     * 仅 append:false 全量文本帧应设置（如 `partial:${taskId}`）。
     */
    coalesceKey?: string;
    /** 发送前延迟（drain 内 sleep，阻塞后续帧）。 */
    delayMs?: number;
    /** 实际发送闭包（帧应在入队前完成组帧与上下文捕获）。 */
    send: () => Promise<void>;
}
export declare class OutboundQueue {
    private readonly sessionId;
    private items;
    private draining;
    /** 当前 drain 循环的 Promise；空闲时为已 resolve 的 Promise。 */
    private drainPromise;
    private destroyed;
    constructor(sessionId: string);
    enqueue(frame: OutboundFrame): void;
    /** 丢弃指定 taskId 的全部待发帧（steer/cancel 场景；在途帧无法撤回）。 */
    purge(taskId: string): void;
    /** 会话销毁：丢弃全部待发帧，后续入队直接丢弃。 */
    destroy(): void;
    /**
     * 等待队列排空。等待期间新入队的帧也会被等到（循环检查）。
     * drain 不 reject（帧级异常已内部捕获），此 Promise 不会失败。
     */
    whenIdle(): Promise<void>;
    private drain;
}

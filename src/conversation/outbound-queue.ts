// Outbound queue — 对话管理层的每会话出站队列。
//
// 收拢原散落在 reply-dispatcher processingLock / 各处直发中的时序职责：
// 所有发往 xy server 的帧（partial/status/final/命令/工具注入）都经此队列
// 串行发出，形成会话级唯一时序收口点。
//
// 设计要点：
//   - drain 单飞串行：取帧 → coalescing 检查 → delayMs sleep → await send()。
//     单帧异常只记日志，不阻塞后续帧。
//   - coalescing 仅作用于 append:false 全量文本帧（自覆盖语义：同 key 只发
//     最新一帧是安全的）；status/final/命令帧不传 coalesceKey，永不参与。
//   - delayMs 在 drain 内 sleep，阻塞后续帧 —— 正是终态帧延迟想要的语义：
//     让已发出的长正文先穿过下游服务端慢速管道（openclaw6.6 3e7b1aa/cdc4cdc）。
//   - whenIdle() 等待队列排空，含等待期间新入队的帧。
//   - 本模块只做时序，不组帧不感知 transport；send 闭包由调用方构造。

import { logger } from "../utils/logger.js";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OutboundQueue {
  private items: OutboundFrame[] = [];
  private draining = false;
  /** 当前 drain 循环的 Promise；空闲时为已 resolve 的 Promise。 */
  private drainPromise: Promise<void> = Promise.resolve();
  private destroyed = false;

  constructor(private readonly sessionId: string) {}

  enqueue(frame: OutboundFrame): void {
    if (this.destroyed) {
      logger.withContext(this.sessionId, frame.taskId).log(
        `[OUTBOUND-QUEUE] Queue destroyed, dropping frame: ${frame.label}`,
      );
      return;
    }
    this.items.push(frame);
    if (!this.draining) {
      this.draining = true;
      this.drainPromise = this.drain();
    }
  }

  /** 丢弃指定 taskId 的全部待发帧（steer/cancel 场景；在途帧无法撤回）。 */
  purge(taskId: string): void {
    const before = this.items.length;
    this.items = this.items.filter((f) => f.taskId !== taskId);
    const dropped = before - this.items.length;
    if (dropped > 0) {
      logger.withContext(this.sessionId, taskId).log(
        `[OUTBOUND-QUEUE] Purged ${dropped} pending frame(s) for task`,
      );
    }
  }

  /** 会话销毁：丢弃全部待发帧，后续入队直接丢弃。 */
  destroy(): void {
    this.destroyed = true;
    this.items = [];
  }

  /**
   * 等待队列排空。等待期间新入队的帧也会被等到（循环检查）。
   * drain 不 reject（帧级异常已内部捕获），此 Promise 不会失败。
   */
  async whenIdle(): Promise<void> {
    while (this.draining || this.items.length > 0) {
      await this.drainPromise;
    }
  }

  private async drain(): Promise<void> {
    const log = logger.withContext(this.sessionId, "");
    try {
      while (this.items.length > 0) {
        const frame = this.items.shift()!;
        // coalescing：后方有同 key 帧时本帧可丢（全量帧自覆盖语义）。
        if (
          frame.coalesceKey &&
          this.items.some((f) => f.coalesceKey === frame.coalesceKey)
        ) {
          continue;
        }
        if (frame.delayMs && frame.delayMs > 0) {
          log.log(`[OUTBOUND-QUEUE] Delaying frame by ${frame.delayMs}ms: ${frame.label}`);
          await sleep(frame.delayMs);
        }
        try {
          await frame.send();
        } catch (err) {
          logger.withContext(this.sessionId, frame.taskId).error(
            `[OUTBOUND-QUEUE] Frame send failed: ${frame.label}`,
            err,
          );
        }
      }
    } finally {
      this.draining = false;
      // finally 期间可能有新帧入队（draining 已置 false 时 enqueue 会自启
      // 新 drain；此处兜底：若 enqueue 发生在 draining=false 判定之前则补一轮）。
      if (this.items.length > 0 && !this.draining) {
        this.draining = true;
        this.drainPromise = this.drain();
      }
    }
  }
}

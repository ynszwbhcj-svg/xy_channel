import type { OutboundWebSocketMessage } from "./types.js";

const MAX_QUEUE_SIZE = 1000;

/**
 * Simple message queue for buffering outbound WebSocket messages
 * during disconnection and reconnection stabilization period.
 */
export class MessageQueue {
  private items: OutboundWebSocketMessage[] = [];
  private log: (msg: string, ...args: any[]) => void;

  constructor(log?: (msg: string, ...args: any[]) => void) {
    this.log = log ?? console.log;
  }

  /** Enqueue a message. Drops oldest if over limit. */
  enqueue(message: OutboundWebSocketMessage): void {
    if (this.items.length >= MAX_QUEUE_SIZE) {
      this.log(`[MessageQueue] Queue full (${MAX_QUEUE_SIZE}), dropping oldest message`);
      this.items.shift();
    }
    this.items.push(message);
    this.log(`[MessageQueue] Enqueued message, queue size: ${this.items.length}`);
  }

  /** Flush all queued messages by calling sendFn for each, then clear. */
  flush(sendFn: (message: OutboundWebSocketMessage) => void): void {
    const count = this.items.length;
    if (count === 0) {
      this.log("[MessageQueue] Queue empty, nothing to flush");
      return;
    }

    this.log(`[MessageQueue] Flushing ${count} queued messages`);
    for (const msg of this.items) {
      try {
        sendFn(msg);
      } catch (err) {
        this.log(`[MessageQueue] Error flushing message: ${err}`);
      }
    }
    this.items = [];
    this.log(`[MessageQueue] Flush complete`);
  }

  /** Clear all queued messages without sending. */
  clear(): void {
    const count = this.items.length;
    this.items = [];
    if (count > 0) {
      this.log(`[MessageQueue] Cleared ${count} messages`);
    }
  }

  get size(): number {
    return this.items.length;
  }
}

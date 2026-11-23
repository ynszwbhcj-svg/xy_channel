import type { OutboundWebSocketMessage } from "../types.js";
/**
 * Simple message queue for buffering outbound WebSocket messages
 * during disconnection and reconnection stabilization period.
 */
export declare class MessageQueue {
    private items;
    private log;
    constructor(log?: (msg: string, ...args: any[]) => void);
    /** Enqueue a message. Drops oldest if over limit. */
    enqueue(message: OutboundWebSocketMessage): void;
    /** Flush all queued messages by calling sendFn for each, then clear. */
    flush(sendFn: (message: OutboundWebSocketMessage) => void): void;
    /** Clear all queued messages without sending. */
    clear(): void;
    get size(): number;
}

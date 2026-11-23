import type { XYChannelConfig, A2ACommand } from "./types.js";
export interface SendCommandViaPushParams {
    config: XYChannelConfig;
    command: A2ACommand;
    /** 指定设备的 pushId（多设备路由）。未传时回退到 getAllPushIds()[0]。 */
    pushId?: string;
}
/**
 * Send a tool command through the push channel (for cron-triggered tool calls).
 *
 * Flow:
 *  1. Push notification is sent with command embedded in data.directives
 *  2. Device receives push → extracts directives → executes command
 *  3. Device returns result via WebSocket (data-event / gui-agent-response / …)
 *  4. The calling tool listens on the WebSocket manager as usual
 */
export declare function sendCommandViaPush(params: SendCommandViaPushParams): Promise<void>;

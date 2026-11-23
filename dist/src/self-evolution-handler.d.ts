import type { XYWebSocketManager } from "./transport/websocket.js";
export declare function handleSelfEvolutionEvent(context: any, cfg: any): Promise<void>;
/**
 * 读取 .xiaoyiruntime 中的 selfEvolutionState 并直接通过 wsManager 下发指令回复设备
 * 参考trigger实现：直接使用当前已连接的 wsManager 发送消息，避免 getXYWebSocketManager 返回未连接实例
 */
export declare function handleSelfEvolutionStateGetEvent(context: any, cfg: any, runtime: any, wsManager: XYWebSocketManager): Promise<void>;

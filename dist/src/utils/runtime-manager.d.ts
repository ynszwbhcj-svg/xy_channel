/**
 * 保存 runtime 信息到 .xiaoyiruntime 文件
 * @param webSocketSessionId - WebSocket 层级的 sessionId (SESSION_ID)
 * @param conversationId - param 里的 sessionId (CONVERSATION_ID)
 * @param taskId - 任务 ID (param.id)
 */
export declare function saveRuntimeInfo(webSocketSessionId: string, conversationId: string, taskId: string): Promise<void>;

/**
 * conv_id 校验：非空字符串，且不含路径分隔符/遍历片段/控制字符
 * （conv_id 要参与 sessions 目录下的文件名前缀匹配）。
 */
export declare function validateTopicDeleteConvId(value: unknown): string | null;
/**
 * Permanently delete every file named `<convId>.*` beneath sessionsDir —
 * hard delete, no recoverable copy left on disk (topic deletion must not
 * leave residue the way the gateway's own transcript archiving does).
 *
 * Returns the deleted absolute paths. Missing directory / unreadable
 * entries are skipped (best effort).
 */
export declare function deleteSessionFilesByConvId(convId: string, sessionsDir: string): string[];
export declare function handleAgentTopicDeleteEvent(context: any, cfg: any, accountId?: string): Promise<void>;

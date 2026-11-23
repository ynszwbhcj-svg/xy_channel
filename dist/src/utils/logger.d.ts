export declare function setA2AOutLogEnabled(v: boolean): void;
export declare function isA2AOutLogEnabled(): boolean;
export interface ScopedLogger {
    log(message: string, ...args: any[]): void;
    warn(message: string, ...args: any[]): void;
    error(message: string, ...args: any[]): void;
    debug(message: string, ...args: any[]): void;
}
export declare const logger: {
    log(message: string, ...args: any[]): void;
    warn(message: string, ...args: any[]): void;
    error(message: string, ...args: any[]): void;
    debug(message: string, ...args: any[]): void;
    /** Create a scoped logger with explicit sessionId/taskId (bypasses AsyncLocalStorage/globalThis). */
    withContext(sessionId: string, taskId: string): ScopedLogger;
};

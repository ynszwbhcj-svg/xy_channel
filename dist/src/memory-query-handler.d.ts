export declare const MEMORY_FILE_ROOT = "/home/sandbox/.openclaw/workspace/memory/celia_memory";
type MemoryFileErrorCode = "INVALID_REQUEST" | "INVALID_PATH" | "NOT_FOUND" | "IO_ERROR";
type MemoryFileFailure = {
    ok: false;
    errorCode: MemoryFileErrorCode;
    message: string;
};
type MemoryFileWriteResult = {
    ok: true;
    bytesWritten: number;
} | MemoryFileFailure;
type MemoryFileReadResult = {
    ok: true;
    content: string;
    contentBytes: number;
} | MemoryFileFailure;
export declare function handleMemoryQueryEvent(context: any, cfg: any): Promise<any>;
/** Atomically write UTF-8 text beneath the fixed memory file root. */
export declare function handleMemoryFileWrite(params: any, rootDir?: string): MemoryFileWriteResult;
/** Read UTF-8 text beneath the fixed memory file root without interpreting it. */
export declare function handleMemoryFileRead(params: any, rootDir?: string): MemoryFileReadResult;
export {};

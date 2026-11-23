/**
 * 在临界区内执行 fn。同一进程内并发调用按调用顺序排队，前一个完成后
 * 才执行下一个，保证临界区内对共享文件/内存的读改写原子化。
 */
export declare function withAsyncLock<T>(fn: () => Promise<T>): Promise<T>;

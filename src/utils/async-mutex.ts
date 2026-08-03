// 进程内异步互斥锁 —— 串行化「读文件 → 改内存 → 写回」型临界区。
// 用途：pushdata-manager / cron-push-map 的 read-modify-write 在并发
// （cron flush / 工具调用）下会"后写覆盖先写"导致丢记录，用本锁排队执行。
let chain: Promise<unknown> = Promise.resolve();

/**
 * 在临界区内执行 fn。同一进程内并发调用按调用顺序排队，前一个完成后
 * 才执行下一个，保证临界区内对共享文件/内存的读改写原子化。
 */
export function withAsyncLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  // 无论 fn 成功失败都重置链尾，使下一次调用仍能排队
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

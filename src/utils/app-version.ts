// 低版本 App 判定注册表。
//
// 上行消息的 variables.systemVariables.app_ver 携带小艺 App 版本号；
// 低于 LEGACY_APP_VERSION（11.7.9.330）的版本不支持 A2A 链路下发的
// isNew 标识 —— 这些版本的会话，所有出站帧的 isNew 置为 false。
//   - 按 taskId 记录：消息入口（bot.ts）抽取 app_ver 时标记；
//   - 未携带 app_ver 的消息不标记（默认非低版本，isNew 保持 true）；
//   - turn 结束（final 帧发出）或会话销毁时释放。
//
// 叶子模块：不依赖 conversation/dispatch 层。

/** 低版本阈值：低于 11.7.9.330 视为低版本。 */
const LEGACY_APP_VERSION = [11, 7, 9, 330] as const;

/** taskId → 是否低版本。 */
const legacyAppVersionByTask = new Map<string, boolean>();

/** 逐段数值比较：appVer 低于阈值返回 true；等于或高于返回 false。 */
export function isBelowLegacyAppVersion(appVer: string): boolean {
  const parts = appVer.split(".").map((s) => Number.parseInt(s, 10));
  for (let i = 0; i < LEGACY_APP_VERSION.length; i++) {
    const v = parts[i];
    const n = v === undefined || Number.isNaN(v) ? 0 : v;
    if (n < LEGACY_APP_VERSION[i]) return true;
    if (n > LEGACY_APP_VERSION[i]) return false;
  }
  return false;
}

/** 消息入口标记本 taskId 的 App 版本（appVer 缺失时不标记，保持默认）。 */
export function markAppVersion(taskId: string, appVer: string | null | undefined): void {
  if (!appVer) return;
  legacyAppVersionByTask.set(taskId, isBelowLegacyAppVersion(appVer));
}

/** 查询指定 taskId 是否低版本（默认 false）。 */
export function isLegacyAppVersion(taskId: string): boolean {
  return legacyAppVersionByTask.get(taskId) === true;
}

/** 释放指定 taskId 的版本标记（turn 结束 / 会话销毁时调用）。幂等。 */
export function releaseAppVersion(taskId: string): void {
  legacyAppVersionByTask.delete(taskId);
}

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
/**
 * 从 openclaw sessionKey 解析 cron jobId。
 * 格式形如 `agent:<agentId>:cron:<jobId>:run:<startedAtTs>`（隔离 run 为
 * `cron:<jobId>`），jobId 位于 "cron:" 之后到下一个冒号/空白之前。
 */
export declare function parseCronJobIdFromSessionKey(sessionKey: string): string | undefined;
/**
 * Block tools that cannot produce a meaningful device-side result during cron.
 * Normal conversations never receive the run marker and keep the original behavior.
 */
export declare function registerCronToolGuard(api: OpenClawPluginApi): void;

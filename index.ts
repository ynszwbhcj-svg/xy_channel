// Plugin registration entry point
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { definePluginEntry, type OpenClawPluginDefinition } from "openclaw/plugin-sdk/core";
import { xiaoyiProvider } from "./src/provider.js";
import { xyPlugin } from "./src/channel.js";
import registerSentinelHook from "./src/cspl/sentinel_hook.js";
import { setXYRuntime } from "./src/runtime.js";
import { markCronToolCall, clearCronToolCall, getCurrentSessionContext } from "./src/tools/session-manager.js";
import { configManager } from "./src/utils/config-manager.js";
import { setJobPushId } from "./src/utils/cron-push-map.js";
import { getAllPushIds } from "./src/utils/pushid-manager.js";
import { registerSelfEvolutionToolResultNudge } from "./src/self-evolution-tool-result-nudge.js";
import { createBeforePromptBuildHandler } from "./src/skill-retriever/hooks.js";
import { normalizeToolRetrieverConfig } from "./src/skill-retriever/config.js";
import { registerCLIHook } from "./src/tools/hmos-cli.js";
import { recoverCronState } from "./src/cron-recovery.js";
import type { CronRecoveryResult } from "./src/cron-recovery.js";
import { logger } from "./src/utils/logger.js";

/**
 * Register the cron detection hook.
 *
 * When openclaw's cron runner triggers a tool call, the sessionKey has the
 * format "cron:<jobId>".  We use this to mark the toolCallId in a global Map
 * so that sendCommand() can route the command through the push channel
 * instead of the (non-existent) WebSocket session.
 */
function registerCronDetectionHook(api: OpenClawPluginApi) {
  api.on("before_tool_call", async (event, ctx) => {
    if (ctx.sessionKey?.startsWith("cron:") && event.toolCallId) {
      markCronToolCall(event.toolCallId);
    }
  });

  api.on("after_tool_call", async (event, ctx) => {
    if (event.toolCallId) {
      clearCronToolCall(event.toolCallId);
    }
    // 捕获对话创建的 cron job：agent 调 cron(add) 后，从 result 拿 jobId，
    // 配合当前会话的 pushId，写入 jobId↔pushId 映射，供 fire 时反查设备。
    await captureCronAddMapping(event, ctx).catch((err) => {
      // 捕获失败不影响工具结果
      console.error("[xy] captureCronAddMapping failed:", err);
    });
  });
}

/** 从 cron add 工具结果中提取 jobId 并写入 pushId 映射。 */
async function captureCronAddMapping(
  event: { toolName?: string; params?: Record<string, unknown>; result?: unknown },
  ctx: { sessionKey?: string },
): Promise<void> {
  // 两条创建路径都要捕获：
  //   1) cron agent 工具：toolName==="cron", params.action==="add"
  //   2) exec 跑 CLI：toolName==="exec", params.command 含 "cron add"
  //      （agent 实际用的是这条：openclaw cron add --name ... --cron ... --message ...）
  const isCronAddTool =
    event.toolName === "cron" &&
    (event.params?.action === "add" || event.params?.action === "create");
  const isExecCronAdd =
    event.toolName === "exec" && isExecCronAddCommand(event.params?.command);

  if (!isCronAddTool && !isExecCronAdd) return;

  console.log(
    `[CRONMAP] after_tool_call path=${event.toolName}, resultType=${typeof event.result}`,
  );

  const jobId = readJobIdFromResult(event.result);
  if (!jobId) {
    console.log(`[CRONMAP] skip: could not extract jobId. preview=${preview(event.result)}`);
    return;
  }
  console.log(`[CRONMAP] extracted jobId=${jobId}`);

  const sessionCtx = getCurrentSessionContext();
  const sessionId = sessionCtx?.sessionId;
  if (!sessionId) {
    console.log(`[CRONMAP] skip: no sessionId in ALS scope (ctxFound=${!!sessionCtx})`);
    return;
  }

  const pushId = await resolvePushId(sessionId);
  if (!pushId) {
    console.log(`[CRONMAP] skip: no pushId available for sessionId=${sessionId} (no session match, no global, no file)`);
    return;
  }

  console.log(`[CRONMAP] writing map: jobId=${jobId}, sessionId=${sessionId}, pushId=${pushId.substring(0, 16)}...`);
  await setJobPushId(jobId, {
    pushId,
    sessionId,
    deviceType: sessionCtx?.deviceType,
    source: event.toolName === "exec" ? "exec-cli" : "conversation",
  });
  console.log(`[CRONMAP] map written OK`);
}

/** 回退链取 pushId：当前会话 → 全局兜底 → 本地文件首个（保底）。 */
async function resolvePushId(sessionId: string): Promise<string | null> {
  // 1. 同会话
  const session = configManager.getPushId(sessionId);
  if (session) return session;
  // 2. 全局（任何会话注册过的）
  const global = configManager.getPushId();
  if (global) return global;
  // 3. 文件兜底
  try {
    const all = await getAllPushIds();
    if (all.length > 0) return all[0];
  } catch {
    // ignore
  }
  return null;
}

/** 判断 exec 命令是否为 cron add（匹配 "openclaw cron add" 或裸 "cron add"，排除 list/remove 等）。 */
function isExecCronAddCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return /\bcron\s+add\b/.test(command);
}

/** 取结果的短预览，用于诊断。 */
function preview(value: unknown): string {
  if (value == null) return String(value);
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

/** 防御性地从 cron add 结果中取 job id。
 *  覆盖：裸 job 对象、JSON 字符串、exec 输出文本、
 *  {content:[{text}]} / {stdout} / data/result/job 嵌套。 */
function readJobIdFromResult(result: unknown): string | undefined {
  if (!result) return undefined;

  // {content: [{type:"text", text: "..."}]} — exec 工具的输出信封
  if (result && typeof result === "object") {
    const contentArr = (result as { content?: unknown }).content;
    if (Array.isArray(contentArr)) {
      for (const item of contentArr) {
        if (item && typeof item === "object") {
          const text = (item as { text?: unknown }).text;
          if (typeof text === "string" && text.trim()) {
            const fromContent = readJobIdFromResult(text);
            if (fromContent) return fromContent;
          }
        }
      }
    }
  }

  // {stdout} — 备选 exec 输出信封
  if (result && typeof result === "object") {
    const stdout = (result as { stdout?: unknown }).stdout;
    if (typeof stdout === "string" && stdout.trim()) {
      const fromStdout = readJobIdFromResult(stdout);
      if (fromStdout) return fromStdout;
    }
  }

  let obj: unknown = result;
  if (typeof result === "string") {
    try {
      obj = JSON.parse(result);
    } catch {
      // 纯文本：可能含 stderr 前缀行 + JSON。用正则抓 "id":"..."。
      const m = result.match(/"id"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
      return undefined;
    }
  }
  if (obj && typeof obj === "object") {
    const id = (obj as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) return id.trim();
    for (const k of ["data", "result", "job"] as const) {
      const inner = (obj as Record<string, unknown>)[k];
      if (inner && typeof inner === "object") {
        const innerId = (inner as { id?: unknown }).id;
        if (typeof innerId === "string" && innerId.trim()) return innerId.trim();
      }
    }
  }
  return undefined;
}

// ── Gateway startup: cron state recovery ────────────────────────────────────

/**
 * Register the gateway_start hook for cron state recovery.
 *
 * On gateway startup, checks .openclaw/cron/ for legacy JSON/JSONL files
 * and migrates them into the SQLite state database:
 *  - Reads legacy jobs.json + jobs-state.json → imports into cron_jobs table
 *  - Reads legacy runs/*.jsonl → imports into cron_run_logs table
 *  - Archives migrated files with .migrated suffix
 *
 * Pattern follows legacy-store-migration.ts and legacy-run-log-migration.ts:
 * check → load → import into SQLite → archive old files.
 */
function registerCronRecoveryHook(api: OpenClawPluginApi): void {
  api.on("gateway_start", async (_event: unknown, _ctx: unknown) => {
    const logTag = "[CRON-RECOVERY-HOOK]";
    const startTime = Date.now();
    logger.log(`${logTag} ═══════════════════════════════════════════`);
    logger.log(`${logTag} gateway_start fired — checking for legacy cron files`);
    logger.log(`${logTag} Timestamp: ${new Date().toISOString()}`);
    logger.log(`${logTag} Plugin registration mode: ${api.registrationMode ?? "unknown"}`);

    let result: CronRecoveryResult;
    try {
      result = await recoverCronState();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? err.stack : undefined;
      logger.error(`${logTag} cron state recovery threw: ${errMsg}`);
      if (errStack) logger.error(`${logTag} Stack: ${errStack}`);
      // Don't let a recovery failure block gateway startup.
      logger.log(
        `${logTag} Recovery failed after ${Date.now() - startTime}ms — gateway startup continues`,
      );
      return;
    }

    const elapsed = Date.now() - startTime;

    if (result.recovered) {
      logger.log(
        `${logTag} ✅ Migration performed successfully in ${elapsed}ms:` +
          ` storeMigrated=${result.storeMigrated}, ` +
          ` runLogFilesImported=${result.runLogFilesImported}`,
      );
    } else {
      logger.log(
        `${logTag} ℹ️ No legacy cron files migrated in ${elapsed}ms ` +
          `(nothing to migrate or database unavailable)`,
      );
    }

    // Log diagnostics summary
    const warnings = result.diagnostics.filter((d) =>
      d.includes("skipping") || d.includes("locked") || d.includes("unavailable"),
    );
    const errors = result.diagnostics.filter((d) =>
      d.includes("error") || d.includes("failed") || d.includes("Failed"),
    );

    if (warnings.length > 0) {
      logger.warn(
        `${logTag} ${warnings.length} warning(s) from migration:`,
      );
      for (const w of warnings) {
        logger.warn(`${logTag}   ⚠ ${w}`);
      }
    }

    if (errors.length > 0) {
      logger.error(
        `${logTag} ${errors.length} error(s) from migration:`,
      );
      for (const e of errors) {
        logger.error(`${logTag}   ✗ ${e}`);
      }
    }

    if (warnings.length === 0 && errors.length === 0) {
      logger.log(`${logTag} All diagnostics clean, no warnings or errors`);
    }

    logger.log(`${logTag} ═══════════════════════════════════════════`);
  });
}

function registerFullHooks(api: OpenClawPluginApi) {
  // SKILL RETRIEVER HOOK: before_prompt_build hook
  const pluginConfig = (api as { pluginConfig?: unknown }).pluginConfig as Record<string, unknown> || {};
  const skillRetrieverConfig = normalizeToolRetrieverConfig({
    enabled: pluginConfig.skillRetrieverEnabled ?? true,
    maxTools: pluginConfig.skillRetrieverMaxTools ?? 2,
    includeUninstalledOnly: true,
    envFilePath: "~/.openclaw/.xiaoyienv",
    timeoutMs: pluginConfig.skillRetrieverTimeoutMs ?? 1000,
  });
  const beforePromptBuildHandler = createBeforePromptBuildHandler(skillRetrieverConfig);
  api.on("before_prompt_build", beforePromptBuildHandler);
  registerSelfEvolutionToolResultNudge(api);
}

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "xiaoyi-channel",
  name: "Xiaoyi Channel",
  description: "Xiaoyi channel plugin - Xiaoyi A2A protocol integration",
  register(api: OpenClawPluginApi) {
    // Always register the provider so wrapStreamFn/prepareExtraParams work
    // in ALL registration modes (not just "full").
    api.registerProvider(xiaoyiProvider);

    if (api.registrationMode === "cli-metadata") {
      return;
    }

    if (api.registrationMode === "tool-discovery") {
      registerFullHooks(api);
      return;
    }

    // Register channel plugin and set runtime
    api.registerChannel({ plugin: xyPlugin });
    setXYRuntime(api.runtime);

    if (api.registrationMode === "discovery") {
      return;
    }

    if (api.registrationMode === "full") {
      registerFullHooks(api);
      // CSPL sentinel hook: before_tool_call + after_tool_call security scanning
      registerSentinelHook(api);
      // Cron detection hook: marks toolCallIds from cron sessions
      registerCronDetectionHook(api);
      // CLI exec hook: intercepts built-in exec for HarmonyOS CLI skill tools
      registerCLIHook(api);
      // Cron recovery hook: prunes stale cron-push-map and pushData on gateway startup
      registerCronRecoveryHook(api);
    }
  },
});

export default plugin;

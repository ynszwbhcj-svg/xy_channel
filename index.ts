// Plugin registration entry point
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { definePluginEntry, type OpenClawPluginDefinition } from "openclaw/plugin-sdk/core";
import { xiaoyiProvider } from "./src/provider.js";
import { xiaoyiCompactionProvider } from "./src/compaction-provider.js";
import { xyPlugin } from "./src/channel.js";
import registerSentinelHook from "./src/cspl/sentinel_hook.js";
import registerSkillScopeHook from "./src/cspl/skill_scope_hook.js";
import { setXYRuntime } from "./src/runtime.js";
import { markCronToolCall, clearCronToolCall, getCurrentSessionContext, setCronToolRunInfo, clearCronToolRunInfo, isCronActive } from "./src/tools/session-manager.js";
import { configManager } from "./src/utils/config-manager.js";
import { setJobPushId } from "./src/utils/cron-push-map.js";
import { getAllPushIds } from "./src/utils/pushid-manager.js";
import { registerSelfEvolutionToolResultNudge } from "./src/self-evolution-tool-result-nudge.js";
import { createBeforePromptBuildHandler } from "./src/skill-retriever/hooks.js";
import { normalizeToolRetrieverConfig } from "./src/skill-retriever/config.js";
import { registerCLIHook } from "./src/tools/hmos-cli.js";
import { recoverCronState } from "./src/cron-recovery.js";
import type { CronRecoveryResult } from "./src/cron-recovery.js";
import { writeSkillUsage } from "./src/utils/skills-logger.js";
import {
  markSubagentSpawned,
  markSubagentEnded,
  deliverSubagentFinalResult,
} from "./src/conversation/conversation-manager.js";
import { notifyCronAgentEnd } from "./src/conversation/cron-buffer.js";
import { logger } from "./src/utils/logger.js";

/**
 * Parse a file path string to detect if it refers to a SKILL.md file within
 * a skills directory. Returns the skill name (parent directory) if so.
 *
 * Matches paths like:
 *   ~/.openclaw/workspace/skills/my-skill/SKILL.md
 *   /home/user/core_skills/my-skill/SKILL.md
 *   skills/my-skill/SKILL.md
 */
function extractSkillNameFromPath(filePath: unknown): string | null {
  if (typeof filePath !== "string" || !filePath) return null;
  // Normalize common path prefixes
  const normalized = filePath.replace(/^~\//, "/home/").replace(/\\/g, "/");
  // Match: .../skills/<skillName>/SKILL.md  or  .../skills/<skillName>/...
  // Also match: .../core_skills/<skillName>/SKILL.md
  const match = normalized.match(/\/(?:core_)?skills\/([^/]+)\/SKILL\.md$/i);
  return match ? match[1] : null;
}

/**
 * Register the skills diagnostic event listener via after_tool_call hook.
 *
 * When openclaw fires a `skill.used` diagnostic event, the skill's SKILL.md
 * is typically read by the model first.  We detect SKILL.md reads through
 * the `after_tool_call` hook and write the skill name to the skills log.
 */
function registerSkillsDiagnosticHook(api: OpenClawPluginApi) {
  // Tool name → skill name mapping for direct tool-based skill usage logging
  const TOOL_SKILL_MAP: Record<string, string> = {
    get_user_location: "GetCurrentLocation",
    get_calendar_tool_schema: "Schedule",
    get_note_tool_schema: "memorandum",
    get_photo_tool_schema: "gallery",
    get_contact_tool_schema: "contact",
    get_device_file_tool_schema: "file",
    get_alarm_tool_schema: "clock",
    message: "message",
    get_phone_tool_schema: "phone",
    get_collection_tool_schema: "xiaoyi-collection",
    image_reading: "xiaoyi-image-understanding"
  };

  // Log skill usage for known device tools on before_tool_call
  api.on("before_tool_call", async (event, _ctx) => {
    const skillName = TOOL_SKILL_MAP[event.toolName];
    if (skillName) {
      writeSkillUsage(skillName);
    }
  });

  // Detect SKILL.md reads on after_tool_call (original behavior)
  api.on("after_tool_call", async (event, _ctx) => {
    if (event.toolName === "read") {
      const skillName = extractSkillNameFromPath(event.params?.path);
      if (skillName) {
        writeSkillUsage(skillName);
      }
    }
  });
}
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
    // sessionKey 前缀依赖 openclaw 版本行为，不一定可靠；
    // isCronActive() 由 provider.ts 根据消息内容 [cron:...] 设置，更可靠。
    if ((ctx.sessionKey?.startsWith("cron:") || isCronActive()) && event.toolCallId) {
      markCronToolCall(event.toolCallId);
      // 存储 runId，供 call_device_tool 在 ALS 缺失时构造合成 SessionContext
      if (event.runId) {
        setCronToolRunInfo(event.toolCallId, event.runId);
      }
    }
  });

  api.on("after_tool_call", async (event, ctx) => {
    if (event.toolCallId) {
      clearCronToolCall(event.toolCallId);
      clearCronToolRunInfo(event.toolCallId);
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

/**
 * 从 sessions_spawn 工具结果中提取 ACP child sessionKey。
 * 兼容三种 result 形态：{status, childSessionKey} 直返、JSON 字符串、
 * {content:[{text: "<json>"}], details:{...}} 工具信封。
 * 仅接受 status="accepted" 且 key 形如 agent:<id>:acp:<uuid> 的结果。
 */
function extractAcceptedAcpChildSessionKey(result: unknown): string | null {
  const pick = (obj: unknown): string | null => {
    if (!obj || typeof obj !== "object") return null;
    const record = obj as Record<string, unknown>;
    if (record.status !== "accepted") return null;
    const key = record.childSessionKey;
    return typeof key === "string" && key.includes(":acp:") ? key : null;
  };

  const direct = pick(result);
  if (direct) return direct;

  const envelope = result as { details?: unknown; content?: Array<{ text?: unknown }> } | null;
  const fromDetails = pick(envelope?.details);
  if (fromDetails) return fromDetails;

  if (Array.isArray(envelope?.content)) {
    for (const item of envelope.content) {
      if (typeof item?.text !== "string") continue;
      try {
        const fromText = pick(JSON.parse(item.text));
        if (fromText) return fromText;
      } catch {
        // 非 JSON 文本，忽略
      }
    }
  }

  if (typeof result === "string") {
    try {
      return pick(JSON.parse(result));
    } catch {
      return null;
    }
  }
  return null;
}

function registerSubagentHooks(api: OpenClawPluginApi) {
  // subagent_spawned: fires after a subagent run is successfully registered.
  // We increment the expected completion count so that onIdle knows to wait.
  api.on("subagent_spawned", async (_event, ctx) => {
    const requesterSessionKey = ctx?.requesterSessionKey;
    if (!requesterSessionKey) return;
    const count = markSubagentSpawned(requesterSessionKey);
    if (count > 0) {
      logger.log(`[XY-SUBAGENT] spawned, requesterSessionKey=${requesterSessionKey.slice(0, 30)}, expected=${count}`);
    }
  });

  // ACP SPAWN TRACKING: openclaw 的 subagent_spawned hook 仅由内嵌 subagent
  // 路径（subagent-spawn.ts）发射；acp-spawn.ts（runtime="acp"，如 Claude Code）
  // 不发射 —— 实测 ACP run 仅在结束时经 run registry 触发 subagent_ended，
  // 导致等待态从未建立、父 turn onIdle 直接发 final 结束对话。
  // 因此在 after_tool_call 补记：sessions_spawn 成功且 childSessionKey 为 ACP
  // 形态时递增等待计数。内嵌 subagent 的 childKey 形如 agent:<id>:subagent:<id>，
  // 不命中此分支，仍由 subagent_spawned hook 负责，不会重复计数。
  api.on("after_tool_call", async (event, ctx) => {
    try {
      if (event?.toolName !== "sessions_spawn" || event?.error) return;
      const childKey = extractAcceptedAcpChildSessionKey(event?.result);
      if (!childKey) return;
      const sessionKey = ctx?.sessionKey;
      if (!sessionKey) return;
      const count = markSubagentSpawned(sessionKey);
      if (count > 0) {
        logger.log(`[XY-SUBAGENT] ACP spawned, childSessionKey=${childKey.slice(0, 40)}, expected=${count}`);
      }
    } catch (err) {
      logger.error(`[XY-SUBAGENT] Error tracking ACP spawn:`, err);
    }
  });

  // subagent_ended: fires when a subagent run terminates (complete/error/killed).
  // This is the PRIMARY delivery tracking mechanism. When all expected
  // subagents have ended and parent has settled, we finalize the A2A session.
  api.on("subagent_ended", async (event, ctx) => {
    try {
      const requesterSessionKey = ctx?.requesterSessionKey;
      if (!requesterSessionKey) {
        logger.log(`[XY-SUBAGENT-END] no requesterSessionKey in ctx`);
        return;
      }
      const transition = markSubagentEnded(requesterSessionKey);
      logger.log(`[XY-SUBAGENT-END] ended, targetSessionKey=${event?.targetSessionKey?.slice(0, 30)}, outcome=${event?.outcome}, complete=${transition?.isComplete ?? false}, shouldFinalize=${transition?.shouldFinalize ?? false}, transition=${!!transition}`);

      if (transition?.shouldFinalize) {
        logger.log(`[XY-SUBAGENT-END] Starting finalization...`);
        // Grace: announce 投递的 sendText 与 subagent_ended hook 并发到达
        // （实测 sendText 可能先于 hook 约 1s，也可能略晚于 hook），
        // 短等让最后一条完成文本先落入 completionTexts 再合并发 final 帧。
        await new Promise((r) => setTimeout(r, 1500));
        // 最终交付由对话管理层统一负责（含 config 解析、final 帧、清理）
        await deliverSubagentFinalResult({
          state: transition.state,
          reason: "all-subagents-ended-after-parent-settled",
        });
        logger.log(`[XY-SUBAGENT-END] Finalized A2A session after all subagents ended`);
      }
    } catch (err) {
      logger.error(`[XY-SUBAGENT-END] Error in subagent_ended hook:`, err);
    }
  });
}

function registerFullHooks(api: OpenClawPluginApi) {
  // SUBAGENT HOOKS: track subagent spawn/end lifecycle for session keep-alive
  registerSubagentHooks(api);

  // CRON AGGREGATION: 通过 agent 事件总线感知 cron isolated run 结束。
  // 注意：agent_end 插件 hook 只在 dispatch-from-config 路径触发，cron
  // isolated run 不会触发它；embedded run 的 lifecycle 事件才是可靠信号。
  // phase=end/error 后到达的 sendText 即为 announce 最终结果（放行）。
  api.agent.events.registerAgentEventSubscription({
    id: "xy-cron-turn-tracker",
    description: "Track cron isolated run completion for sendText aggregation",
    streams: ["lifecycle"],
    handle: (event) => {
      try {
        const phase = event?.data?.phase;
        // 仅 phase=end 是 run 级终态信号；phase=error 可能是单次模型调用
        // 失败（后续还有重试/start），不能据此放行 announce。
        // 真正失败的 run（无 end）由 120s 安全超时兜底 flush 缓冲文本。
        if (phase !== "end") return;
        const sessionKey = event?.sessionKey ?? "";
        if (sessionKey.startsWith("cron:") || sessionKey.includes(":cron:") || isCronActive()) {
          logger.log(`[XY-CRON] Cron run lifecycle end, sessionKey=${sessionKey || "unknown"}`);
          notifyCronAgentEnd();
        }
      } catch (err) {
        logger.error(`[XY-CRON] Error in cron lifecycle subscription:`, err);
      }
    },
  });

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
  api.on("before_prompt_build", async (event, ctx) => {
    logger.log(`[BEFORE_PROMPT_BUILD] hook fired, sessionKey=${ctx.sessionKey || "undefined"}, sessionId=${ctx.sessionId || "undefined"}`);
    return beforePromptBuildHandler(event, ctx);
  });
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

    // Register the compaction provider so openclaw's safeguard hook uses
    // our summarization path (which injects x-hag-trace-id) instead of the
    // built-in LLM path that bypasses wrapStreamFn.
    api.registerCompactionProvider(xiaoyiCompactionProvider);

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
      // CSPL skill scope hook: before_install security scanning
      registerSkillScopeHook(api);
      // Cron detection hook: marks toolCallIds from cron sessions
      registerCronDetectionHook(api);
      // CLI exec hook: intercepts built-in exec for HarmonyOS CLI skill tools
      registerCLIHook(api);
      // Cron recovery hook: prunes stale cron-push-map and pushData on gateway startup
      registerCronRecoveryHook(api);
      // Skills diagnostic hook: log skill usage (detected via SKILL.md reads)
      registerSkillsDiagnosticHook(api);
    }
  },
});

export default plugin;

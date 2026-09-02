// step-info-tool — 工具执行步骤信息 + 技能使用通知（before/after_tool_call 钩子）
//
// 两个能力合并在本模块（原 skill-tool 已并入）：
//
// 1) StepInfo 命令（namespace=Common, name=StepInfo）：分类内工具执行时下发
//    - before_tool_call → eventType="tool_call"，携带 arguments（调用参数）
//    - after_tool_call  → eventType="tool_result"，携带 success + result：
//        成功 → success=true，result=执行结果
//        失败 → success=false，result=报错信息
//    - displayName 按分类映射（网页搜索/运行命令/文件创建/编辑文件/读取文件/
//      查找文件/分析图片/生成图片/生成音乐/生成视频/下载文件/使用工具）
//
// 2) 技能命令（namespace=Common, name=Action）：模型 cd 进技能目录或读
//    技能 SKILL.md 时下发，payload={ skillName, text }
//    - cd 进技能目录 → text=使用技能 <skillName>
//    - 读 SKILL.md    → text=查看技能 <skillName>（同命令内 cd+读 md 判为查看）
//    - 合并去重：read 工具读 SKILL.md 时只发技能命令，不再发「读取文件」
//      StepInfo；read 普通文件只发「读取文件」StepInfo。
//    - exec 命令命中技能检测时，技能命令与「运行命令」StepInfo 并存。
//
// 仅下发分类内工具；未映射工具（cron、sessions_* 系列、subagents、
// memory_* 系列、tts 等其余 general 工具与全部端工具）静默跳过。
// 命令经 formatter.sendCommand 下发，路由与 channel 其它命令一致：
// 普通对话 WS、cron run push 通道。
//
// 钩子体全 try/catch：before_tool_call 抛错会 block 工具执行，
// 命令下发失败绝不能影响工具本身。

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { sendCommand } from "../formatter.js";
import {
  resolveBySessionKey,
  getCachedXYConfig,
} from "../conversation/conversation-manager.js";
import {
  getCurrentSessionContext,
  isCronToolCall,
  getCronToolRunInfo,
} from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ACommand, XYChannelConfig } from "../types.js";

const LOG_TAG = "[STEP-INFO]";

/** 单字段序列化长度上限（字符）。超出时只带预览片段 + truncated 标记。 */
const MAX_FIELD_LENGTH = 8000;

/**
 * displayName 分类映射（保留自工具分类整理结论）。
 *
 * - Web: 网页搜索;Command: 运行命令;File-create: 文件创建;File-edit: 编辑文件
 * - File-read: 读取文件;File-search: 查找文件(当前无工具);image: 分析图片
 *   (image_generate: 生成图片);music: 生成音乐;video: 生成视频
 * - download: 下载文件(当前无工具);general: 使用工具(仅下列白名单)
 *
 * general 白名单外（cron、gateway、nodes、message、heartbeat_respond、
 * sessions_* 系列、subagents、session_status、memory_* 系列、tts）
 * 与全部端工具不下发命令。
 */
const DISPLAY_BY_TOOL: Record<string, string> = {
  // Web
  web_search: "网页搜索",
  x_search: "网页搜索",
  web_fetch: "网页搜索",
  browser: "网页搜索",
  // Command（bash 为 exec 别名）
  exec: "运行命令",
  bash: "运行命令",
  process: "运行命令",
  code_execution: "运行命令",
  // File-create
  write: "文件创建",
  skill_workshop: "文件创建",
  save_self_evolution_skill: "文件创建",
  // File-edit
  edit: "编辑文件",
  apply_patch: "编辑文件",
  // File-read
  read: "读取文件",
  // Image
  image: "分析图片",
  image_generate: "生成图片",
  // Music / Video
  music_generate: "生成音乐",
  video_generate: "生成视频",
  // General 白名单
  tool_search: "使用工具",
  tool_search_code: "使用工具",
  tool_describe: "使用工具",
  update_plan: "使用工具",
  agents_list: "使用工具",
  convert_timestamp_to_utc8_time: "使用工具",
  view_push_result: "使用工具",
  send_file_to_user: "使用工具",
  canvas: "使用工具",
};

/**
 * 把工具参数/结果转成命令可携带的 JSON 安全字段。
 * 超出上限时只带 preview + truncated 标记（push 通道有载荷限制，exec
 * 输出等可能极大，不能整段塞进命令）。
 */
function normalizeField(value: unknown): unknown {
  if (value === undefined || value === null || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (typeof value === "bigint") return `${value}n`;

  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (json.length <= MAX_FIELD_LENGTH) {
    try {
      return JSON.parse(json);
    } catch {
      return json;
    }
  }
  return {
    truncated: true,
    preview: json.slice(0, MAX_FIELD_LENGTH),
  };
}

// ── 技能检测 ───────────────────────────────────────────────────────

/** 从路径/文本中提取技能名：.../skills/<name> 或 .../core_skills/<name>。 */
function extractSkillNameFromPathText(text: string): string | null {
  const normalized = text.replace(/\\/g, "/");
  const m = normalized.match(/(?:^|[/\s"';&|])(?:core_)?skills\/([^/'"\s;&|]+)/i);
  return m ? m[1] : null;
}

/** 读 SKILL.md 检测：路径形如 .../skills/<name>/SKILL.md（含 core_skills）。 */
function extractSkillNameFromMdPath(text: string): string | null {
  const normalized = text.replace(/\\/g, "/");
  const m = normalized.match(/(?:core_)?skills\/([^/'"\s;&|]+)\/SKILL\.md/i);
  return m ? m[1] : null;
}

/**
 * 从 exec 命令中识别「cd 进技能目录」，返回技能名。
 * 支持：cd skills/foo、cd ~/.openclaw/workspace/skills/foo、
 * cd "core_skills/foo"、cd skills/foo/sub（取 skills 后的第一段）。
 */
function detectCdIntoSkill(command: string): string | null {
  const normalized = command.replace(/\\/g, "/");
  const cdMatch = normalized.match(/\bcd\s+["']?([^"';&|]+)/i);
  if (!cdMatch) return null;
  return extractSkillNameFromPathText(cdMatch[1]);
}

/** read 工具路径分类：技能 SKILL.md 或普通文件。 */
function classifyReadPath(path: unknown): { kind: "skill"; skillName: string } | { kind: "normal" } | null {
  if (typeof path !== "string" || path.trim().length === 0) return null;
  const skillName = extractSkillNameFromMdPath(path);
  if (skillName) return { kind: "skill", skillName };
  return { kind: "normal" };
}

/**
 * 识别当前工具调用的技能动作（exec 命令内容 / read 路径）。
 * 返回 null 表示不命中；read 优先（同命令内 cd+读 md → 判为 read）。
 */
function detectSkillAction(
  event: { toolName?: string; params?: Record<string, unknown> },
): { action: "view" | "use"; skillName: string } | null {
  if (event.toolName === "read") {
    const classified = classifyReadPath(event.params?.path);
    if (classified?.kind === "skill") return { action: "view", skillName: classified.skillName };
    return null;
  }

  if (event.toolName === "exec") {
    const command = event.params?.command;
    if (typeof command !== "string" || command.trim().length === 0) return null;

    const mdSkillName = extractSkillNameFromMdPath(command);
    if (mdSkillName) return { action: "view", skillName: mdSkillName };

    const cdSkillName = detectCdIntoSkill(command);
    if (cdSkillName) return { action: "use", skillName: cdSkillName };
    return null;
  }

  return null;
}

/** 判断该工具调用是否应跳过 StepInfo（read 技能 SKILL.md 只发技能命令）。 */
function shouldSkipStepInfo(event: { toolName?: string; params?: Record<string, unknown> }): boolean {
  if (event.toolName !== "read") return false;
  return classifyReadPath(event.params?.path)?.kind === "skill";
}

// ── 下发目标解析 ───────────────────────────────────────────────────

/** 解析下发目标会话上下文：主会话 binding → ALS → cron 合成 ctx → 放弃。 */
function resolveSendContext(
  event: { toolCallId?: string },
  ctx: { sessionKey?: string },
): { config: XYChannelConfig; sessionId: string; taskId: string; messageId: string } | null {
  // 1. 主会话对话路径：sessionKey → A2A binding（与 tool-status-hook 一致）
  const binding = resolveBySessionKey(ctx.sessionKey ?? "");
  if (binding) {
    const cached = getCachedXYConfig();
    const config = (cached as XYChannelConfig) ?? null;
    if (config) {
      return {
        config,
        sessionId: binding.sessionId,
        taskId: binding.taskId,
        messageId: binding.messageId,
      };
    }
  }

  // 2. ALS 会话上下文（普通 turn 兜底；cron 时 provider 已把 jobId 绑定到
  //    该 sessionId，push 路由能命中 cron-push-map 的精确设备）
  const alsCtx = getCurrentSessionContext();
  if (alsCtx?.sessionId) {
    return {
      config: alsCtx.config,
      sessionId: alsCtx.sessionId,
      taskId: alsCtx.taskId,
      messageId: alsCtx.messageId,
    };
  }

  // 3. cron 无 ALS：sessionKey 带 "cron:" 前缀（openclaw 自身行为，不依赖
  //    其它 before_tool_call 钩子的标记时序）或 toolCallId 已被 cron 检测
  //    钩子标记时，按 call-device-tool 同款方式构造合成 ctx（"cron-" 前缀
  //    使 sendCommand 路由到 push 通道）
  const sessionKey = ctx.sessionKey ?? "";
  const toolCallId = event.toolCallId ?? "";
  if (sessionKey.includes("cron:") || isCronToolCall(toolCallId)) {
    const runInfo = getCronToolRunInfo(toolCallId);
    const cached = getCachedXYConfig();
    const config = (cached as XYChannelConfig) ?? null;
    if (config) {
      return {
        config,
        sessionId: `cron-${(runInfo?.runId ?? toolCallId).replace(/-/g, "")}`,
        taskId: runInfo?.runId ?? toolCallId,
        messageId: "",
      };
    }
  }

  return null;
}

// ── 命令下发 ───────────────────────────────────────────────────────

/** 下发一条 StepInfo 命令。 */
async function sendStepInfo(params: {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  toolCallId?: string;
  toolName: string;
  displayName: string;
  eventType: "tool_call" | "tool_result";
  success?: boolean;
  arguments?: unknown;
  result?: unknown;
}): Promise<void> {
  const command: A2ACommand = {
    header: { namespace: "Common", name: "StepInfo" },
    payload: {
      toolName: params.toolName,
      displayName: params.displayName,
      eventType: params.eventType,
      ...(params.success !== undefined ? { success: params.success } : {}),
      ...(params.arguments !== undefined ? { arguments: params.arguments } : {}),
      ...(params.result !== undefined ? { result: params.result } : {}),
    },
  };

  await sendCommand({
    config: params.config,
    sessionId: params.sessionId,
    taskId: params.taskId,
    messageId: params.messageId,
    command,
    toolCallId: params.toolCallId,
  });
}

/** 下发一条技能命令（Common/Action，payload={ skillName, text }）。 */
async function sendSkillCommand(params: {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  toolCallId?: string;
  action: "view" | "use";
  skillName: string;
}): Promise<void> {
  const text =
    params.action === "view"
      ? `查看技能 ${params.skillName}`
      : `使用技能 ${params.skillName}`;

  const command: A2ACommand = {
    header: { namespace: "Common", name: "Action" },
    payload: {
      skillName: params.skillName,
      text,
    },
  };

  await sendCommand({
    config: params.config,
    sessionId: params.sessionId,
    taskId: params.taskId,
    messageId: params.messageId,
    command,
    toolCallId: params.toolCallId,
  });
}

/**
 * Register the step-info + skill hooks on the OpenClaw plugin API.
 * Call during `registrationMode === "full"` in the plugin entry point.
 */
export function registerStepInfoHook(api: OpenClawPluginApi): void {
  // 工具执行前：技能命令 + StepInfo(tool_call, arguments)
  api.on("before_tool_call", async (event, ctx) => {
    try {
      const sendCtx = resolveSendContext(event, ctx);
      if (!sendCtx) return;

      // 1. 技能命令（cd 进技能目录 / 读 SKILL.md）
      const skillAction = detectSkillAction(event);
      if (skillAction) {
        await sendSkillCommand({
          ...sendCtx,
          toolCallId: event.toolCallId,
          action: skillAction.action,
          skillName: skillAction.skillName,
        });
        logger.log(
          `${LOG_TAG} sent skill ${skillAction.action} skill=${skillAction.skillName}`,
        );
      }

      // 2. StepInfo（read 技能 SKILL.md 时只走技能命令，跳过读取文件）
      if (shouldSkipStepInfo(event)) {
        logger.log(`${LOG_TAG} skip StepInfo: read skill SKILL.md, tool=${event.toolName}`);
        return;
      }
      const displayName = DISPLAY_BY_TOOL[event.toolName];
      if (!displayName) return;

      await sendStepInfo({
        ...sendCtx,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        displayName,
        eventType: "tool_call",
        arguments: normalizeField(event.params),
      });

      logger.log(`${LOG_TAG} sent tool_call tool=${event.toolName} display=${displayName}`);
    } catch (err) {
      // 命令下发失败绝不能 block 工具执行
      logger.error(`${LOG_TAG} before_tool_call hook failed:`, err);
    }
  });

  // 工具执行后：StepInfo(tool_result, success + result)
  api.on("after_tool_call", async (event, ctx) => {
    try {
      // read 技能 SKILL.md 的 result 也不发 StepInfo（与 before 侧去重对齐）
      if (shouldSkipStepInfo(event)) return;
      const displayName = DISPLAY_BY_TOOL[event.toolName];
      if (!displayName) return;

      const sendCtx = resolveSendContext(event, ctx);
      if (!sendCtx) {
        logger.log(`${LOG_TAG} skip tool_result: no send context, tool=${event.toolName}`);
        return;
      }

      // 成功 → success=true + 执行结果；失败 → success=false + 报错信息
      const failed = event.error !== undefined && event.error !== null;
      const rawResult = failed
        ? (typeof event.error === "string" ? event.error : JSON.stringify(event.error))
        : event.result;

      await sendStepInfo({
        ...sendCtx,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        displayName,
        eventType: "tool_result",
        success: !failed,
        result: normalizeField(rawResult),
      });

      logger.log(
        `${LOG_TAG} sent tool_result tool=${event.toolName} display=${displayName} success=${!failed}`,
      );
    } catch (err) {
      logger.error(`${LOG_TAG} after_tool_call hook failed:`, err);
    }
  });
}

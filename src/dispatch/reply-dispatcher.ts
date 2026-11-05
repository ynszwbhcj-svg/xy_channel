// Reply dispatcher - completely following feishu/reply-dispatcher.ts pattern
import type { ClawdbotConfig, RuntimeEnv, ReplyPayload } from "openclaw/plugin-sdk";
import { getXYRuntime } from "../runtime.js";
import { sendA2AResponse, sendStatusUpdate, sendReasoningTextUpdate, sendCommand, sendDisplayTaskCardData, sendExecuteStatusCard } from "../formatter.js";
import { resolveXYConfig } from "../config.js";
import type { A2ACommand, RunCrossTaskContext, XYChannelConfig } from "../types.js";
import { clearRunCrossTaskSentFiles, getCurrentSessionContext } from "../tools/session-manager.js";
import fs from "fs/promises";
import path from "path";
import { logger } from "../utils/logger.js";
import {
  getWaitState,
  clearWaitState,
  getCurrentTaskId,
  getCurrentMessageId,
  getOrCreateSession,
  getSession,
  startStatusHeartbeat,
  stopStatusHeartbeat,
  setSessionState,
  clearTurnInflight,
  isTurnCanceled,
  isTurnSuperseded,
  deliverSubagentFinalResult,
} from "../conversation/conversation-manager.js";
import { StreamAssembler } from "../conversation/stream-assembler.js";
import { markReasoningFinished, markReasoningStreaming } from "../utils/reasoning-state.js";
import { getCurrentStatusCardSeq } from "../utils/status-card-seq.js";
import { markLastChunkBlock, getAccumulatedThinkIndex } from "../utils/think-index.js";

/** 延后收尾期间的上游 run 轮询间隔。 */
const EMPTY_IDLE_POLL_MS = 1_000;
/** 上游 run 退出后再给 followup drain 的落地窗口；期间收到 reply 会立即唤醒。 */
const FOLLOWUP_SETTLE_MS = 5_000;
/** 延后收尾的硬上限：上游 run 长期不退时也要释放 dispatcher。 */
const EMPTY_IDLE_MAX_MS = 60_000;

// ⚙️ 前缀是 openclaw 系统消息稳定标记（infra/system-message.ts SYSTEM_MARK）。
// ACP 绑定会话 turn 结束会以 kind=final 尾随投递系统诊断通知（如
// "Session ids resolved"），deliver 捕获权威文本时必须排除，否则最终帧
// 会把答案替换成通知。
const SYSTEM_NOTICE_MARK = "⚙️";
function isSystemNoticeText(text: string): boolean {
  return text.trimStart().startsWith(SYSTEM_NOTICE_MARK);
}

// ⚠️ openclaw 侧将“上下文溢出 / 自动压缩失败 / 预压缩失败”等技术性英文失败文案
// 直接作为最终回复下发给用户，通道层此前未做任何中文化，中文用户会看到英文报错。
// 这里对特征鲜明、不可能出现在正常中文回复里的稳定开头做前缀匹配，整段替换为
// 中文兜底提示，避免裸英文技术报错暴露给用户；不使用模糊子串，以免误伤正常回复。
interface OpenclawFailureRule {
  /** 英文失败文案的稳定开头（唯一、可区分）。 */
  prefixRe: RegExp;
  /** 命中后整段替换为的中文兜底文案。 */
  replacement: string;
}

const OPENCLAW_FAILURE_RULES: OpenclawFailureRule[] = [
  {
    // #1 buildContextOverflowRecoveryText：Auto-compaction could not recover this turn...
    // 前缀 ⚠️ 视 openclaw 实际输出可有可无：⚠ 与变体选择符是两个码点，必须整体用
    // (?:⚠️)? 做成可选，不能写 ⚠️?（那样 ? 仅作用于变体选择符，⚠ 仍是强制）。
    // 且真实消息在 this 与 turn 之间可能插入换行（this \r\nturn），
    // 故用 [\s\S]{0,3} 容忍最多 3 个任意字符（空格/CR/LF）以兼容换行。
    prefixRe: /^(?:⚠️)?\s*Auto-compaction could not recover this[\s\S]{0,3}turn/i,
    replacement:
      "⚠️ 上下文处理过程中出现异常，未能完成回复。建议清除当前上下文后重试。",
  },
  {
    // #2 CONTEXT_OVERFLOW_ERROR_MESSAGE：Context overflow: prompt too large for the model...
    prefixRe: /^(?:⚠️)?\s*Context overflow:\s*prompt too large for the model/i,
    replacement:
      "⚠️ 上下文长度超出模型限制，未能完成回复。建议清除当前上下文（新建/重置会话）后重试。",
  },
  {
    // #3 buildPreflightCompactionFailureText：This conversation is too long...
    prefixRe: /^(?:⚠️)?\s*This conversation is too long,\s*and OpenClaw couldn\'t shorten it\b/i,
    replacement:
      "⚠️ 上下文内容过长且整理失败，未能完成回复。建议清除当前上下文后重试。",
  },
];

/** 将 openclaw 技术性英文失败文案替换为中文兜底提示；未命中则原样返回。 */
function rewriteOpenclawFailureText(text: string): string {
  if (!text) {
    return text;
  }
  for (const rule of OPENCLAW_FAILURE_RULES) {
    if (rule.prefixRe.test(text.trimStart())) {
      return rule.replacement;
    }
  }
  return text;
}

export interface CreateXYReplyDispatcherParams {
  cfg: ClawdbotConfig;
  runtime: RuntimeEnv;
  sessionId: string;
  taskId: string;
  messageId: string;
  accountId: string;
  /** Called at end of onIdle, after final frame is sent. openclaw's waitForIdle() does
   *  not await the async onIdle, so cleanup must happen inside onIdle itself. */
  onIdleComplete?: () => void | Promise<void>;
  /**
   * channel 侧注入：空 idle 时上游是否仍有活跃 run（可能有 followup 排队）。
   * 由 bot.ts 用已暴露的 resolveActiveEmbeddedRunSessionId 实现；本文件不引入
   * 新的 openclaw 运行时依赖，保证既有 dispatcher 单测的模块桩不变。
   */
  isUpstreamRunActive?: () => boolean;
}

const TEMP_FILE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RUN_CROSS_TASK_LOG_TAG = "[RunCrossTask]";

function buildDistributionStatusCommand(context: RunCrossTaskContext): A2ACommand {
  return {
    header: {
      namespace: "DistributionInteraction",
      name: "DistributionStatus",
    },
    payload: {
      agentId: context.agentId,
      isDistributed: true,
      networkId: context.networkId,
      distributionType: "softbus",
      distributionExecutePolicy: "backgroundExecution",
    },
  };
}

function buildCrossTaskExecuteResultCommand(
  code: string,
  message: string,
  sentFiles: NonNullable<RunCrossTaskContext["sentFiles"]> = [],
): A2ACommand {
  return {
    header: {
      namespace: "DistributionInteraction",
      name: "CrossTaskExecuteResult",
    },
    payload: {
      code,
      message,
      sentFiles,
    },
  };
}

async function sendRunCrossTaskResult(params: {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  context: RunCrossTaskContext;
  resultCode: string;
  resultMessage: string;
}): Promise<void> {
  const { config, sessionId, taskId, messageId, context, resultCode, resultMessage } = params;
  const sentFiles = Array.isArray(context.sentFiles) ? context.sentFiles : [];
  const fileCardCount = sentFiles.length;
  const statusCommand = buildDistributionStatusCommand(context);
  const resultCommand = buildCrossTaskExecuteResultCommand(resultCode, resultMessage, sentFiles);

  try {
    await sendCommand({
      config,
      sessionId,
      taskId,
      messageId,
      commands: [statusCommand, resultCommand],
    });
    logger.log(`${RUN_CROSS_TASK_LOG_TAG} sent cross-task result, sessionId=${sessionId}, taskId=${taskId}, code=${resultCode}, fileCardCount=${fileCardCount}, messageLength=${resultMessage.length}`);
  } finally {
    clearRunCrossTaskSentFiles(context);
    logger.log(`${RUN_CROSS_TASK_LOG_TAG} cleared cross-task sentFiles, sessionId=${sessionId}, taskId=${taskId}, clearedFileCardCount=${fileCardCount}`);
  }
}

/**
 * 清理 /tmp/xy_channel 目录中超过 24 小时的旧文件
 */
export async function cleanupStaleTempFiles(tempDir: string = "/tmp/xy_channel"): Promise<void> {
  try {
    const stats = await fs.stat(tempDir).catch(() => null);
    if (!stats?.isDirectory()) {
      return;
    }

    const files = await fs.readdir(tempDir);
    const now = Date.now();
    let cleanedCount = 0;

    for (const file of files) {
      const filePath = path.join(tempDir, file);
      try {
        const fileStat = await fs.stat(filePath);
        if (now - fileStat.mtimeMs > TEMP_FILE_TTL_MS) {
          await fs.unlink(filePath);
          cleanedCount++;
        }
      } catch (err) {
        // 忽略单个文件处理失败
      }
    }

    if (cleanedCount > 0) {
      logger.log(`[CLEANUP] Cleaned ${cleanedCount} stale files (>${TEMP_FILE_TTL_MS / 1000 / 3600}h) from ${tempDir}`);
    }
  } catch (err) {
    logger.error(`[CLEANUP] Failed to cleanup temp dir:`, err);
  }
}

/**
 * Create a reply dispatcher for XY channel messages.
 * Follows feishu pattern with status updates and streaming support.
 * Runtime is expected to be validated before calling this function.
 */
export function createXYReplyDispatcher(params: CreateXYReplyDispatcherParams): any {
  const { cfg, runtime, sessionId, taskId, messageId, accountId, onIdleComplete, isUpstreamRunActive } = params;

  // fallback taskId/messageId（当对话管理层任务链为空时使用）
  const currentFallbackTaskId = taskId;
  const currentFallbackMessageId = messageId;

  // 跨链读取：steer 消息通过对话管理层更新任务链，这里读取最新 taskId
  const getActiveTaskId = (): string => {
    return getCurrentTaskId(sessionId) ?? currentFallbackTaskId;
  };

  const getActiveMessageId = (): string => {
    return getCurrentMessageId(sessionId) ?? currentFallbackMessageId;
  };

  // Create a scoped logger that always uses this session's sessionId
  // and dynamically resolves the latest taskId
  const scopedLog = () => logger.withContext(sessionId, getActiveTaskId());

  scopedLog().log(`[DISPATCHER-CREATE] Creating dispatcher`);

  const core = getXYRuntime();
  const config: XYChannelConfig = resolveXYConfig(cfg);
  // Simplified prefix context for single-account Xiaoyi channel
  const prefixContext = {
    responsePrefix: undefined,
    responsePrefixContextProvider: undefined,
    onModelSelected: undefined,
  };

  let hasSentResponse = false;
  let finalSent = false;

  // ── 空 idle 延后收尾状态 ────────────────────────────────────────────
  // openclaw 把消息排进 followup 时，本次 dispatch 不会立刻产出 reply。此时
  // hasSentResponse=false 不代表失败：直接发 99921111 + final:true + cleanup 会
  // 清掉 task 归属，让 followup 排队的真回复无处投递。仅当「无明确报错且上游
  // 仍有活跃 run」时才延后收尾；其余真失败保持原有立即失败逻辑不变。
  let hadReplyError = false;
  let deferFinalization = false;
  let quietFinalization = false;
  let graceExpired = false;
  let graceStartedAt = 0;
  let upstreamClearedAt = 0;
  let emptyIdleTimer: ReturnType<typeof setTimeout> | null = null;
  let handleIdleRef: () => Promise<void> = async () => {};

  // 当前思考块的最新全量快照（onReasoningStream 的 append:false 语义即全量），
  // 供 onReasoningEnd 的思考块结束标记帧携带全量文本
  let lastReasoningText = "";

  // ── 文本装配与出站时序由对话管理层拥有 ─────────────────────
  // assembler：model/injected 段拼接 + deliver 权威文本修正，生命周期随本
  // dispatcher（同时挂载到 session 上，供 display-a2ui-card 等工具注入文本段）。
  // outboundQueue：会话级出站 FIFO，所有出站帧的唯一时序收口（partial 帧
  // coalescing、终态帧 delayMs）。dispatcher 只做事件翻译和业务决策。
  const session = getOrCreateSession(sessionId);
  const assembler = new StreamAssembler();
  session.assembler = assembler;
  const outboundQueue = session.outboundQueue;
  // 终态帧延迟：正文 artifact 与终态帧几乎同一毫秒发出，下游服务端对长正文
  // 走慢速管道会把正文延迟到最后投递，导致微服务先收到终态帧（0 关闭）。
  const terminalFrameDelayMs = config.terminalFrameDelayMs ?? 0;

  // 串行化 onPartialReply 回调体：SDK fire-and-forget 模式下多个回调可能
  // 并发进入，streamChain 保证 assembler 读写互斥；onIdle 在 finalize 前
  // await 它，确保在途回调全部落账（否则读取的装配状态缺最后几个流式块）。
  let streamChain: Promise<void> = Promise.resolve();
  const initialRunCrossTaskContext = getCurrentSessionContext()?.runCrossTaskContext;

  const getRunCrossTaskContext = (): RunCrossTaskContext | undefined => {
    return getCurrentSessionContext()?.runCrossTaskContext ?? initialRunCrossTaskContext;
  };

  /**
   * 30s 状态心跳由对话管理层拥有（manager-owned），dispatcher 仅做委托。
   * 心跳独立于 dispatcher 生命周期：subagent 等待期间 dispatcher 销毁后
   * 心跳仍由 manager 维持。
   */
  const startStatusInterval = () => {
    startStatusHeartbeat(sessionId);
  };

  const stopStatusInterval = () => {
    stopStatusHeartbeat(sessionId);
  };

  const isOutputStale = (): boolean =>
    isTurnCanceled(sessionId, taskId) || isTurnSuperseded(sessionId, taskId);

  const finishIdle = async (preserveHeartbeat: boolean): Promise<void> => {
    if (!preserveHeartbeat) {
      stopStatusInterval();
    }
    // 仅卸载本 dispatcher 的 assembler，避免误删 steer 新 dispatcher 的实例。
    if (session.assembler === assembler) {
      session.assembler = undefined;
    }
    await onIdleComplete?.();
  };

  /** 空 idle 时上游是否仍有活跃 run（由 bot.ts 注入的可观测信号）。 */
  const hasActiveUpstreamRun = (): boolean => {
    if (!isUpstreamRunActive) return false;
    try {
      return !!isUpstreamRunActive();
    } catch {
      return false;
    }
  };

  const clearEmptyIdleTimer = () => {
    if (emptyIdleTimer) {
      clearTimeout(emptyIdleTimer);
      emptyIdleTimer = null;
    }
  };

  const reenterIdle = () => {
    void handleIdleRef().catch((err) => scopedLog().error(`[ON-IDLE] Re-entered idle failed:`, err));
  };

  /** 延后期间收到 reply 或明确报错：结束宽限期，立即重新走一次 idle 收尾。 */
  const resumeIdleAfterDefer = () => {
    if (!emptyIdleTimer) return;
    clearEmptyIdleTimer();
    graceExpired = true;
    // 让本轮 deliver/onError 先把自己的帧入队，再重进 idle。
    void Promise.resolve().then(reenterIdle);
  };

  /**
   * 延后期间轮询上游 run：run 退出后再留 FOLLOWUP_SETTLE_MS 给 followup drain
   * 落地，期间本 dispatcher 收到 reply 会由 resumeIdleAfterDefer 提前唤醒。
   * 结束时按共享会话状态决定收口方式：
   *  - 仍是本 turn 的 working（或会话已消失）→ 真静默失败，落回原有失败逻辑，
   *    保证端侧一定能收到终帧，不会挂住卡片；
   *  - 其余状态说明别的 dispatcher 已收口或仍在途 → 静默，绝不补发失败帧。
   */
  const onGraceTick = () => {
    emptyIdleTimer = null;
    if (hasActiveUpstreamRun()) {
      // followup 排队的 run 已启动，重新计时等待它跑完。
      upstreamClearedAt = 0;
    } else if (upstreamClearedAt === 0) {
      upstreamClearedAt = Date.now();
    }
    const settled = upstreamClearedAt > 0 && Date.now() - upstreamClearedAt >= FOLLOWUP_SETTLE_MS;
    if (!settled && Date.now() - graceStartedAt < EMPTY_IDLE_MAX_MS) {
      emptyIdleTimer = setTimeout(onGraceTick, EMPTY_IDLE_POLL_MS);
      return;
    }

    graceExpired = true;
    const state = getSession(sessionId)?.state;
    const genuineSilentFailure = !state || state === "working";
    quietFinalization = !genuineSilentFailure;
    scopedLog().log(
      `[ON-IDLE] Deferred idle grace ended, sessionState=${state} — ${genuineSilentFailure ? "original failure finalization" : "quiet finalization"}`,
    );
    reenterIdle();
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, accountId),

      onReplyStart: () => {
        scopedLog().log(`[REPLY-START] Reply started, taskId=${taskId}`);
      },

      deliver: async (payload: ReplyPayload, info) => {
        if (isOutputStale()) {
          scopedLog().log(`[DELIVER SKIP] Canceled/superseded turn`);
          return;
        }
        let text = payload.text ?? "";

        // 将 compaction 通知替换为中文提示
        if (payload.isCompactionNotice && text) {
          text = text
            .replace(
              /^🧹 Compacting context \((\d+) messages\) so I can continue without losing history…$/,
              "🧹 正在整理上下文（共 $1 条消息），请稍候…",
            )
            .replace(/^🧹 Compacting context\.\.\.$/, "🧹 正在整理上下文…")
            .replace(/^🧹 Compaction complete$/, "🧹 上下文整理完成")
            .replace(/^🧹 Compaction incomplete$/, "🧹 上下文整理未完成")
            .replace(/^🧹 Compaction not needed$/, "🧹 无需整理上下文")
            .replace(/^✅ Context compacted.*$/, "✅ 上下文整理完成，继续之前的工作。");
        }

        // ⚠️ 将 openclaw 技术性英文失败文案替换为中文兜底提示（见 rewriteOpenclawFailureText）
        text = rewriteOpenclawFailureText(text);

        scopedLog().log(`[DELIVER] kind=${info?.kind}, text.length=${text.length}`);

        try {
          if (!text.trim()) {
            scopedLog().log(`[DELIVER SKIP] Empty text, skipping`);
            return;
          }

          // 捕获权威最终文本（canonical，来自最后一条 assistant 消息，
          // 非流式累计），供 onIdle 拼接最终帧。compaction 通知和 ⚙️ 系统
          // 通知（如 ACP "Session ids resolved"）不是答案文本，不能污染。
          if (info?.kind === "final" && !payload.isCompactionNotice && !isSystemNoticeText(text)) {
            assembler.onFinalText(text);
            scopedLog().log(`[DELIVER] Captured final reply text, length=${text.length}`);
          }

          // onPartialReply 已经通过 append:false 全量发送了所有文本，deliver 不再重复发送
          if (hasSentResponse) {
            scopedLog().log(`[DELIVER SKIP] Already sent via onPartialReply`);
            return;
          }

          hasSentResponse = true;
          resumeIdleAfterDefer();

          // 非流式回退路径（onPartialReply 未触发时，如 ACP 绑定会话），
          // 同样经出站队列保序；与流式帧同 coalesceKey，可被后续全量帧合并。
          const deliverTaskId = getActiveTaskId();
          const deliverMessageId = getActiveMessageId();
          outboundQueue.enqueue({
            taskId: deliverTaskId,
            label: "deliver-fallback",
            coalesceKey: `partial:${deliverTaskId}`,
            send: () =>
              sendA2AResponse({
                config,
                sessionId,
                taskId: deliverTaskId,
                messageId: deliverMessageId,
                text,
                append: false,
                final: false,
              }),
          });
        } catch (deliverError) {
          scopedLog().error(`Failed to deliver message:`, deliverError);
        }
      },

      onError: async (err, info) => {
        if (isOutputStale()) {
          scopedLog().log(`[ON-ERROR] Ignoring error from canceled/superseded turn: ${String(err)}`);
          return;
        }
        runtime.error?.(`xy: ${info.kind} reply failed: ${String(err)}`);
        stopStatusInterval();
        // 上游明确报错 → 空 idle 必须按真失败立即收尾，不进入延后宽限期。
        hadReplyError = true;
        // 已处于延后宽限期时立即唤醒收尾，避免等到超时才发失败帧。
        resumeIdleAfterDefer();

        if (!hasSentResponse) {
          const errorTaskId = getActiveTaskId();
          outboundQueue.enqueue({
            taskId: errorTaskId,
            label: "error-status",
            send: () =>
              sendStatusUpdate({
                config,
                sessionId,
                taskId: errorTaskId,
                messageId: getActiveMessageId(),
                text: "处理失败，请稍后重试",
                state: "failed",
              }),
          });
        }
      },

      // 命名函数表达式：把自身暴露给 handleIdleRef，供宽限期结束 / reply 到达时
      // 重新进入一次 idle 收尾，无需搬动下方原有收尾代码。
      onIdle: async function handleIdle() {
        handleIdleRef = handleIdle;
        // 每次进入默认照常收尾；只有下方延后分支会把它置 true。
        deferFinalization = false;

        scopedLog().log(`[ON-IDLE] Reply idle, hasSentResponse=${hasSentResponse}, finalSent=${finalSent}`);

        // 🔑 本 turn 不再产生流式帧：清除在途标记，放行 subagent 终态帧的
        // 时机门控（见 conversation-manager.deliverSubagentFinalResult）。
        clearTurnInflight(sessionId, taskId);

        // 取消的 turn 已由 tasks/cancel 回复 canceled；被新 dispatcher 接替的
        // 旧 turn 也不得发送失败/成功终帧，尤其不能动态挂到新 taskId。
        if (isOutputStale()) {
          const superseded = isTurnSuperseded(sessionId, taskId);
          scopedLog().log(`[ON-IDLE] Suppressing terminal output for canceled/superseded turn`);
          // 早于 try 的分支不走 finally，延后定时器必须在这里自行收掉，
          // 否则会残留到 60s 硬上限后再触发一次多余的 reenterIdle。
          clearEmptyIdleTimer();
          if (!superseded) {
            setSessionState(sessionId, "canceled");
          }
          await finishIdle(superseded);
          return;
        }

        // ── Subagent wait state check ─────────────────────────────
        // If this session has pending subagent completions, suppress final:true
        // and keep the A2A session alive. The final response will be sent when
        // all completions arrive via xyOutbound.sendText interception.
        const waitState = getWaitState(sessionId, taskId) ?? getWaitState(sessionId);
        if (
          waitState &&
          waitState.deliveredCompletions < waitState.expectedCompletions &&
          !finalSent
        ) {
          scopedLog().log(
            `[ON-IDLE] Waiting for subagent completions ${waitState.deliveredCompletions}/${waitState.expectedCompletions}, suppressing final:true`,
          );
          // 会话不结束：转入 waiting-subagent。一次性等待保活帧已下线；
          // 等待期间的保活由 30s 保活卡心跳承担（waiting-subagent 在状态门内）。
          setSessionState(sessionId, "waiting-subagent");
          clearEmptyIdleTimer();
          return;
        }
        // If wait state exists and all subagents are already complete,
        // let onSettled → markParentSettled → deliverSubagentFinalResult
        // handle finalization. Don't send the normal final:true here,
        // otherwise the mock server/client sees two final frames.
        if (waitState && waitState.deliveredCompletions >= waitState.expectedCompletions) {
          scopedLog().log(
            `[ON-IDLE] Subagent completions all arrived (${waitState.deliveredCompletions}/${waitState.expectedCompletions}), deferring final to parent-settled path`,
          );
          // 🔑 父 turn 已 settle 时就地交付：finalize 可能因本 turn 当时在途
          // 被时机门控推迟，而 parentSettled 早已被（旧 dispatcher 的）
          // onSettled 标记 —— 那条路径不会再触发交付，必须由本分支收口。
          // 本 turn 已 idle（在途标记已在入口清除），交付不会被门控拦截；
          // deliverSubagentFinalResult 幂等，重复触发为 no-op。
          if (waitState.parentSettled) {
            await deliverSubagentFinalResult({
              state: waitState,
              reason: "parent-settled-completions-ready-at-idle",
            });
          }
          clearEmptyIdleTimer();
          return;
        }
        // ── End subagent wait state check ─────────────────────────

        // 🔑 用 try/finally 确保 cleanup 在 onIdle 的 async 工作全部完成后才执行。
        // openclaw 的 waitForIdle() 以 void options.onIdle?.() 调用 onIdle，
        // 不会 await 返回的 Promise，因此 onSettled 可能在 onIdle 中途触发。
        // 所有清理逻辑必须放在 finally 块中，不要依赖 onSettled。
        try {
          // 正常模式
          if (hasSentResponse && !finalSent) {
            // 🔑 先等在途 onPartialReply 全部落账，再读装配状态。openclaw 以
            // void fire-and-forget 调用 onPartialReply，onIdle 触发时最后一个
            // 回调可能仍在 streamChain 上排队；提前读取会缺最后几个流式块。
            await streamChain;

            // 等待流式回调期间可能被取消或被新 turn 接替；重新检查后再组终帧。
            if (isOutputStale()) {
              scopedLog().log(`[ON-IDLE] Turn became canceled/superseded while draining stream callbacks`);
              return;
            }

            // 🔑 终态帧延迟会让出宏任务，期间新用户消息可能把 session 绑定
            // 更新到新 task，必须提前捕获 taskId/messageId，避免终态帧误挂到
            // 新 task 上、提前终止新任务的流。
            const terminalTaskId = getActiveTaskId();
            const terminalMessageId = getActiveMessageId();

            // 🔑 进入收尾：先把会话状态置为 completing —— 心跳 tick 对该状态
            // 直接跳过，避免终态帧（completed）发出后、队列 drain 窗口内又
            // 插出一条携带同 streamingTextId 的 working 保活帧。
            setSessionState(sessionId, "completing");

            // 🔑 权威文本合并：deliver(kind=final) 捕获的 canonical 文本
            // （openclaw 从最后一条 assistant 消息直接提取）非空时替换流式
            // 累计的末轮 —— message_end 的最终清洗文本不走 onPartialReply，
            // 流式累计天然可能缺尾，以 canonical 为准。
            const { fullText: fullFinalText, resolvedLastText, diagnostic } = assembler.finalize();
            if (diagnostic === "patched-tail") {
              scopedLog().log(`[ON-IDLE] Streamed text missing tail, patched from final payload, canonical.length=${resolvedLastText.length}`);
            } else if (diagnostic === "canonical-shorter") {
              scopedLog().log(`[ON-IDLE] Final text shorter than streamed, using canonical final, canonical.length=${resolvedLastText.length}`);
            } else if (diagnostic === "diverged") {
              scopedLog().warn(`[ON-IDLE] Final text diverged from streamed text, using canonical final, canonical.length=${resolvedLastText.length}`);
            }
            const crossTaskResultMessage = resolvedLastText.trim();

            scopedLog().log(`[ON-IDLE] [SendCrossResult]Sending cross-task result, resultMessage.length=${crossTaskResultMessage.length}`);
            try {
              const runCrossTaskContext = getRunCrossTaskContext();
              if (runCrossTaskContext) {
                const ctx = runCrossTaskContext;
                outboundQueue.enqueue({
                  taskId: terminalTaskId,
                  label: "cross-task-result",
                  send: () =>
                    sendRunCrossTaskResult({
                      config,
                      sessionId,
                      taskId: terminalTaskId,
                      messageId: terminalMessageId,
                      context: ctx,
                      resultCode: "0",
                      resultMessage: crossTaskResultMessage,
                    }),
                });
              }

              // 🔑 终态帧延迟：让已发出的长正文先穿过下游服务端慢速管道，
              // 保证终态帧最后到达（openclaw6.6 3e7b1aa/cdc4cdc 同款治理，
              // delayMs 在队列 drain 内 sleep，阻塞后续帧）。
              outboundQueue.enqueue({
                taskId: terminalTaskId,
                label: "terminal-status",
                delayMs: terminalFrameDelayMs,
                send: () =>
                  sendStatusUpdate({
                    config,
                    sessionId,
                    taskId: terminalTaskId,
                    messageId: terminalMessageId,
                    text: "已完成深度思考",
                    state: "completed",
                  }),
              });

              // 🔑 正文文本完成帧（lastChunk=true, final=false）：权威全文本在此
              // 补齐（原终帧携带全文本的语义前移到本帧），把 final=true 留给
              // 最后的空载终帧 —— 满足「正文 lastChunk → 汇总卡 → final」时序。
              if (fullFinalText) {
                outboundQueue.enqueue({
                  taskId: terminalTaskId,
                  label: "terminal-text-complete",
                  delayMs: terminalFrameDelayMs,
                  send: () =>
                    sendA2AResponse({
                      config,
                      sessionId,
                      taskId: terminalTaskId,
                      messageId: terminalMessageId,
                      text: fullFinalText,
                      append: false,
                      final: false,
                      lastChunk: true,
                    }),
                });
              }

              // 🔑 汇总状态卡：thinkIndex 攒批（本 turn 内工具卡不逐张携带，
              // 攒到这里统一下发）——携带除最后一轮正文外的前置轮文本块
              // taskUniqIndexId（最后一轮正文的 id = 当前卡序号，过滤掉）。
              // 排在 final 帧之前：终态帧发出后服务端可能关闭本 turn。
              {
                const currentSeq = getCurrentStatusCardSeq(terminalTaskId);
                const summaryThinkIndex = getAccumulatedThinkIndex(terminalTaskId)
                  .filter((id) => id !== String(currentSeq));
                outboundQueue.enqueue({
                  taskId: terminalTaskId,
                  label: "terminal-summary-card",
                  send: () =>
                    sendExecuteStatusCard({
                      config,
                      sessionId,
                      taskId: terminalTaskId,
                      messageId: terminalMessageId,
                      text: "任务处理已完成",
                      thinkIndex: summaryThinkIndex,
                    }),
                });
              }

              // 对话轮结束：DisplayTaskCardData final 帧收尾（起始卡在 bot.ts
              // 下发）。index 在 drain 时惰性读取 —— 排在汇总卡之后，落在
              // 汇总卡的序号上完成配对收尾。
              outboundQueue.enqueue({
                taskId: terminalTaskId,
                label: "task-card-final",
                send: () =>
                  sendDisplayTaskCardData({
                    config,
                    sessionId,
                    taskId: terminalTaskId,
                    messageId: terminalMessageId,
                    index: getCurrentStatusCardSeq(terminalTaskId),
                    stepName: "任务处理已完成",
                    isFinal: true,
                  }),
              });

              // 🔑 空载终帧（append:true, final:true）仅标记流结束 —— 权威全文本
              // 已在上面的 terminal-text-complete 帧下发，本帧不再携带文本。
              outboundQueue.enqueue({
                taskId: terminalTaskId,
                label: "terminal-final",
                delayMs: terminalFrameDelayMs,
                send: () =>
                  sendA2AResponse({
                    config,
                    sessionId,
                    taskId: terminalTaskId,
                    messageId: terminalMessageId,
                    text: "",
                    append: true,
                    final: true,
                  }),
              });

              await outboundQueue.whenIdle();
              finalSent = true;
              if (waitState) {
                clearWaitState(sessionId, "main-final-delivered", taskId);
              }
              setSessionState(sessionId, "completed");
              scopedLog().log(
                `[ON-IDLE] Sent final response (${fullFinalText ? `append=false, full text length=${fullFinalText.length}` : "append=true, empty stream-end"})`,
              );
            } catch (err) {
              scopedLog().error(`[ON-IDLE] Failed to send final response:`, err);
            }
          } else {
            // 回复已由承载 followup 的 dispatcher 交付：本 dispatcher 只做静默
            // 清理，绝不补发 99921111 / final:true（端侧终帧已由对方发出）。
            if (quietFinalization) {
              scopedLog().log(`[ON-IDLE] Reply delivered by another dispatcher, skipping failure frames`);
              return;
            }

            // 已有延后在途时重复进入 onIdle：不得抢发失败帧，也不得收尾。
            if (emptyIdleTimer) {
              deferFinalization = true;
              scopedLog().log(`[ON-IDLE] Deferred finalization already in progress, skipping duplicate idle`);
              return;
            }

            // ── 延后：空 idle 但上游仍可能有排队的回复 ──────────────────
            // 必须是真正的空 idle（无任何回复、未发过终帧），且无明确报错、
            // 上游仍有活跃 run、宽限期未用完；其余全部落到下面的原有失败逻辑。
            if (
              !hasSentResponse &&
              !finalSent &&
              !graceExpired &&
              !hadReplyError &&
              hasActiveUpstreamRun()
            ) {
              deferFinalization = true;
              scopedLog().log(
                `[ON-IDLE] Empty idle with active upstream run — deferring finalization (followup queued)`,
              );
              // 只挂轮询定时器，不发新状态帧、不改在途标记：两者都会污染原有
              // 时序 / supersession 判定。心跳、assembler、task 链全部保持原状。
              if (!emptyIdleTimer) {
                graceStartedAt = Date.now();
                upstreamClearedAt = 0;
                emptyIdleTimer = setTimeout(onGraceTick, EMPTY_IDLE_POLL_MS);
              }
              // return 会进 finally，但 deferFinalization=true 使其跳过 finishIdle。
              return;
            }

            // 正常失败场景
            scopedLog().log(`[ON-IDLE] Skipping final message: hasSentResponse=${hasSentResponse}, finalSent=${finalSent}`);
            const failureTaskId = getActiveTaskId();
            const failureMessageId = getActiveMessageId();
            // 与正常路径同理：入队失败终态帧前置为 failed，关闭心跳保活窗口
            setSessionState(sessionId, "failed");
            try {
              const runCrossTaskContext = getRunCrossTaskContext();
              if (runCrossTaskContext) {
                const ctx = runCrossTaskContext;
                outboundQueue.enqueue({
                  taskId: failureTaskId,
                  label: "cross-task-result-failure",
                  send: () =>
                    sendRunCrossTaskResult({
                      config,
                      sessionId,
                      taskId: failureTaskId,
                      messageId: failureMessageId,
                      context: ctx,
                      resultCode: "1",
                      resultMessage: "任务执行异常，请重试",
                    }),
                });
              }

              outboundQueue.enqueue({
                taskId: failureTaskId,
                label: "failure-status",
                send: () =>
                  sendStatusUpdate({
                    config,
                    sessionId,
                    taskId: failureTaskId,
                    messageId: failureMessageId,
                    text: "任务处理中断了",
                    state: "failed",
                  }),
              });

              // 失败收尾：同样下发 DisplayTaskCardData final 帧关闭起始卡，
              // 否则端侧卡片会一直停留在"任务正在处理中"
              outboundQueue.enqueue({
                taskId: failureTaskId,
                label: "task-card-final-failure",
                send: () =>
                  sendDisplayTaskCardData({
                    config,
                    sessionId,
                    taskId: failureTaskId,
                    messageId: failureMessageId,
                    index: getCurrentStatusCardSeq(failureTaskId),
                    stepName: "任务处理已完成",
                    isFinal: true,
                  }),
              });

              outboundQueue.enqueue({
                taskId: failureTaskId,
                label: "failure-final",
                send: () =>
                  sendA2AResponse({
                    config,
                    sessionId,
                    taskId: failureTaskId,
                    messageId: failureMessageId,
                    text: "任务执行异常，请重试",
                    append: false,
                    final: true,
                    errorCode: 99921111,
                    errorMessage: "任务执行异常，请重试",
                  }),
              });

              await outboundQueue.whenIdle();
              finalSent = true;
              setSessionState(sessionId, "failed");
              scopedLog().log(`[ON-IDLE] Sent error response, code=99921111`);
            } catch (err) {
              scopedLog().error(`[ON-IDLE] Failed to send error response:`, err);
            }
          }
        } finally {
          // openclaw 的 waitForIdle() 不 await onIdle；清理必须在这里完成。
          // 旧 turn 被新 dispatcher 接替时保留新 turn 的心跳。
          // 延后期间不收尾：不停心跳、不卸载 assembler、不触发 onIdleComplete
          // （清 task 链），让 followup 排队的真回复仍能落到正确 taskId。
          if (!deferFinalization) {
            clearEmptyIdleTimer();
            await finishIdle(isTurnSuperseded(sessionId, taskId));
          }
        }
      },

      onCleanup: () => {
        scopedLog().log(`[ON-CLEANUP] Reply cleanup`);
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      // A2A 通道无需 typing indicator，禁用 typing 可让
      // reply-turn-admission 层中的 signalTextDelta 变为 no-op，
      // 从而消除导致 onPartialReply 回调乱序的异步 I/O 根源。
      suppressTyping: true,
      suppressToolErrorWarnings: true,
      onModelSelected: prefixContext.onModelSelected,

      onToolResult: async (payload: ReplyPayload) => {
        if (isOutputStale()) return;
        const text = payload.text ?? "";
        // 工具结果不再下发任何帧（结果卡已移除）；保留日志便于排查
        scopedLog().log(`[TOOL-RESULT] Tool result, text.length: ${text.length}`);
      },

      onReasoningStream: async (payload: ReplyPayload) => {
        if (isOutputStale()) return;
        let text = payload.text ?? "";

        // Strip "Reasoning:" prefix that some reasoning models add to their thinking output
        const lines = text.split(/\r?\n/);
        if (lines[0]?.trim() === "Reasoning:") {
          text = lines.slice(1).join("\n").trim();
        }

        try {
          if (text.length > 0) {
            const reasoningTaskId = getActiveTaskId();
            // 记录当前思考块最新全量快照（append:false 语义即全量），
            // 供思考块结束标记帧携带
            lastReasoningText = text;
            // 新一轮 reasoning 流开始：复位 turn 级 isReasoningFinished
            // （同一 turn 可能有多个 reasoning 块：思考→工具→再思考）。
            markReasoningStreaming(reasoningTaskId);
            outboundQueue.enqueue({
              taskId: reasoningTaskId,
              label: "reasoning-stream",
              send: () =>
                sendReasoningTextUpdate({
                  config,
                  sessionId,
                  taskId: reasoningTaskId,
                  messageId: getActiveMessageId(),
                  text,
                  append: false,
                }),
            });
          }
        } catch (err) {
          scopedLog().error(`[REASONING-STREAM] Failed to send reasoning text:`, err);
        }
      },

      onReasoningEnd: async () => {
        // SDK thinking_end：标记本 turn reasoning 结束，并补发思考块结束标记帧
        // （携带本思考块的全量文本、append=false 快照语义、isReasoningFinished=true
        // + lastChunk=true；两个标记都显式 pin 而非 lazy 读状态表，防止帧在队
        // 期间新一轮 reasoning 复位状态导致标记帧丢失语义），让端侧及时收起
        // 思维链面板并落定该块的完整内容。
        const endTaskId = getActiveTaskId();
        markReasoningFinished(endTaskId);
        // 攒入思考文本块的 taskUniqIndexId：统一在终态汇总卡（text=任务处理
        // 已完成）携带，中间状态卡不携带。同步标记（而非等标记帧 drain），
        // 保证不受出站队列时序影响。
        markLastChunkBlock(endTaskId, getCurrentStatusCardSeq(endTaskId));
        scopedLog().log(`[REASONING-END] Reasoning finished, taskId=${endTaskId}`);

        try {
          // 结束标记帧携带本思考块的全量文本（append=false 快照语义），
          // 值在入队时捕获 —— 防止 drain 前新一轮 reasoning 更新了快照
          const reasoningFullText = lastReasoningText;
          outboundQueue.enqueue({
            taskId: endTaskId,
            label: "reasoning-end",
            send: () =>
              sendReasoningTextUpdate({
                config,
                sessionId,
                taskId: endTaskId,
                messageId: getActiveMessageId(),
                text: reasoningFullText,
                append: false,
                isReasoningFinished: true,
                lastChunk: true,
              }),
          });

          // 思考块结束后紧跟一帧 status-update（"已完成深度思考"），
          // 每个思考块结束时都发；正文完成后不再发（终态帧文案另见
          // terminal-status）。state=working：turn 仍在进行。
          outboundQueue.enqueue({
            taskId: endTaskId,
            label: "reasoning-end-status",
            send: () =>
              sendStatusUpdate({
                config,
                sessionId,
                taskId: endTaskId,
                messageId: getActiveMessageId(),
                text: "已完成深度思考",
                state: "working",
              }),
          });
        } catch (err) {
          scopedLog().error(`[REASONING-END] Failed to send reasoning-end marker:`, err);
        }
      },

      onPartialReply: async (payload: ReplyPayload) => {
        if (isOutputStale()) return;
        const text = payload.text ?? "";
        if (text.length === 0) return;

        hasSentResponse = true;
        resumeIdleAfterDefer();

        // 串行化回调体：SDK fire-and-forget 模式下多个 onPartialReply 可能
        // 并发进入，streamChain 保证 assembler 读写互斥；发送本身由会话
        // 出站队列保序，append:false 全量帧携带 coalesceKey 可被合并。
        const prevChain = streamChain;
        let releaseChain: () => void;
        streamChain = new Promise<void>((resolve) => {
          releaseChain = resolve;
        });

        try {
          await prevChain;
          if (isOutputStale()) return;

          // assembler 内部完成 startsWith 边界检测与跨调用锁存（含轮间换行）
          assembler.onStreamText(text);
          const partialTaskId = getActiveTaskId();
          const partialMessageId = getActiveMessageId();

          // 🔑 帧文本在 drain 时惰性读取装配器，而非入队时捕获快照：
          // 帧在队期间若发生分段边界（工具调用边界 → 轮换
          // streamingTextId + cutSegment），发送时只携带边界后新段的文本，
          // 杜绝在新 streamingTextId 下叠加下发旧 id 段内容。
          outboundQueue.enqueue({
            taskId: partialTaskId,
            label: "partial",
            coalesceKey: `partial:${partialTaskId}`,
            send: () =>
              sendA2AResponse({
                config,
                sessionId,
                taskId: partialTaskId,
                messageId: partialMessageId,
                text: assembler.getFullText(),
                append: false,
                final: false,
                log: false,
              }),
          });
        } catch (err) {
          scopedLog().error(`[PARTIAL-REPLY] Failed to send:`, err);
        } finally {
          releaseChain!();
        }
      },
    },
    markDispatchIdle,
    startStatusInterval,
    stopStatusInterval,
  };
}

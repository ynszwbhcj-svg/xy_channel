// Reply dispatcher - completely following feishu/reply-dispatcher.ts pattern
import type { ClawdbotConfig, RuntimeEnv, ReplyPayload } from "openclaw/plugin-sdk";
import { getXYRuntime } from "../runtime.js";
import { sendA2AResponse, sendStatusUpdate, sendReasoningTextUpdate, sendCommand } from "../formatter.js";
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
  startStatusHeartbeat,
  stopStatusHeartbeat,
  setSessionState,
  clearTurnInflight,
  deliverSubagentFinalResult,
} from "../conversation/conversation-manager.js";
import { StreamAssembler } from "../conversation/stream-assembler.js";
import { sendTurnFinalStepCard } from "../step-progress.js";

// ⚙️ 前缀是 openclaw 系统消息稳定标记（infra/system-message.ts SYSTEM_MARK）。
// ACP 绑定会话 turn 结束会以 kind=final 尾随投递系统诊断通知（如
// "Session ids resolved"），deliver 捕获权威文本时必须排除，否则最终帧
// 会把答案替换成通知。
const SYSTEM_NOTICE_MARK = "⚙️";
function isSystemNoticeText(text: string): boolean {
  return text.trimStart().startsWith(SYSTEM_NOTICE_MARK);
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
  const { cfg, runtime, sessionId, taskId, messageId, accountId, onIdleComplete } = params;

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

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, accountId),

      onReplyStart: () => {
        scopedLog().log(`[REPLY-START] Reply started, taskId=${taskId}`);
      },

      deliver: async (payload: ReplyPayload, info) => {
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
        runtime.error?.(`xy: ${info.kind} reply failed: ${String(err)}`);
        stopStatusInterval();

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

      onIdle: async () => {

        scopedLog().log(`[ON-IDLE] Reply idle, hasSentResponse=${hasSentResponse}, finalSent=${finalSent}`);

        // 🔑 本 turn 不再产生流式帧：清除在途标记，放行 subagent 终态帧的
        // 时机门控（见 conversation-manager.deliverSubagentFinalResult）。
        clearTurnInflight(sessionId, taskId);

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
          // 会话不结束：转入 waiting-subagent，心跳由对话管理层继续维持
          setSessionState(sessionId, "waiting-subagent");
          // 🔑 保活帧必须使用最新 A2A 身份：steer 场景下旧 taskId 已被服务端
          // 作废，用旧身份发帧无任何回应。读任务链末尾（新 dispatcher 场景下
          // 与本 dispatcher 闭包 taskId 一致；旧 dispatcher 晚到触发时除外）。
          const aliveTaskId = getActiveTaskId();
          const aliveMessageId = getActiveMessageId();
          outboundQueue.enqueue({
            taskId: aliveTaskId,
            label: "subagent-waiting-status",
            send: () =>
              sendStatusUpdate({
                config,
                sessionId,
                taskId: aliveTaskId,
                messageId: aliveMessageId,
                text: "子任务正在处理中，请稍候~",
                state: "working",
              }),
          });
          // 心跳由对话管理层拥有，subagent 等待期间自动存活，无需附加到等待态
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

            // 🔑 终态帧延迟会让出宏任务，期间新用户消息可能把 session 绑定
            // 更新到新 task，必须提前捕获 taskId/messageId，避免终态帧误挂到
            // 新 task 上、提前终止新任务的流。
            const terminalTaskId = getActiveTaskId();
            const terminalMessageId = getActiveMessageId();

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
                    text: "任务处理已完成~",
                    state: "completed",
                  }),
              });

              // step 进度收口：下发 DisplayTaskCardData final 帧（「已完成」，
              // index 与最后一张工具卡一致）。本轮没发过进度卡片时内部为 no-op。
              outboundQueue.enqueue({
                taskId: terminalTaskId,
                label: "step-final-card",
                delayMs: terminalFrameDelayMs,
                send: () =>
                  sendTurnFinalStepCard({
                    config,
                    sessionId,
                    taskId: terminalTaskId,
                    messageId: terminalMessageId,
                  }),
              });

              // 🔑 最终帧携带权威全文本（append:false 整体替换）—— 流式期间
              // 缺失的尾部在此补齐。空文本属异常路径，回退旧的空帧语义
              // （append:true 仅标记流结束），避免把客户端已展示内容刷空。
              if (fullFinalText) {
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
                      text: fullFinalText,
                      append: false,
                      final: true,
                    }),
                });
              } else {
                outboundQueue.enqueue({
                  taskId: terminalTaskId,
                  label: "terminal-final-empty",
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
              }

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
            // 正常失败场景
            scopedLog().log(`[ON-IDLE] Skipping final message: hasSentResponse=${hasSentResponse}, finalSent=${finalSent}`);
            const failureTaskId = getActiveTaskId();
            const failureMessageId = getActiveMessageId();
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
                    text: "任务处理中断了~",
                    state: "failed",
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
                    text: "任务执行异常，请重试~",
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
          stopStatusInterval();

          // 卸载 assembler（终态后工具不再有注入窗口）；仅在仍属于本
          // dispatcher 时卸载，避免误删 steer 新 dispatcher 的实例。
          if (session.assembler === assembler) {
            session.assembler = undefined;
          }

          // 🔑 清理必须在 onIdle 内部完成，因为 openclaw 的 waitForIdle() 不会
          // await onIdle 返回的 Promise（源码中为 void options.onIdle?.()），
          // 导致 onSettled 在 onIdle 的 async 工作完成之前就执行。
          await onIdleComplete?.();
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

      onToolStart: async ({ name, phase }) => {
        scopedLog().log(`[TOOL-START] Tool: ${name}, phase: ${phase}`);
      },

      onToolResult: async (payload: ReplyPayload) => {
        const text = payload.text ?? "";
        const hasMedia = Boolean(payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0);

        scopedLog().log(`[TOOL-RESULT] Tool result, text.length: ${text.length}`);

        try {
          if (text.length > 0 || hasMedia) {
            const resultText = text.length > 0 ? text : "工具执行完成";
            const toolTaskId = getActiveTaskId();

            outboundQueue.enqueue({
              taskId: toolTaskId,
              label: "tool-result-status",
              send: () =>
                sendStatusUpdate({
                  config,
                  sessionId,
                  taskId: toolTaskId,
                  messageId: getActiveMessageId(),
                  text: resultText,
                  state: "working",
                }),
            });
            scopedLog().log(`[TOOL-RESULT] Sent tool result as status update`);
          }
        } catch (err) {
          scopedLog().error(`[TOOL-RESULT] Failed to send tool result status:`, err);
        }
      },

      onReasoningStream: async (payload: ReplyPayload) => {
        let text = payload.text ?? "";

        // Strip "Reasoning:" prefix that some reasoning models add to their thinking output
        const lines = text.split(/\r?\n/);
        if (lines[0]?.trim() === "Reasoning:") {
          text = lines.slice(1).join("\n").trim();
        }

        try {
          if (text.length > 0) {
            const reasoningTaskId = getActiveTaskId();
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

      onPartialReply: async (payload: ReplyPayload) => {
        const text = payload.text ?? "";
        if (text.length === 0) return;

        hasSentResponse = true;

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

          // assembler 内部完成 startsWith 边界检测与跨调用锁存（含轮间换行）
          const { fullText } = assembler.onStreamText(text);
          const partialTaskId = getActiveTaskId();
          const partialMessageId = getActiveMessageId();

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
                text: fullText,
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

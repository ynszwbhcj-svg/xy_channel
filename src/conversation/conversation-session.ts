// 对话管理层 —— 会话状态对象定义。
//
// ConversationSession 是对话管理层的核心状态载体，收拢了重构前散落在
// task-manager / subagent-wait-state / reply-dispatcher 闭包中的会话状态：
//   - tasks:        session 的 taskId/messageId 链（吸收自 task-manager）
//   - sessionKey:   openclaw 路由 sessionKey（吸收自 sessionKeyMap）
//   - subagentWaits: subagent 等待态（吸收自 subagent-wait-state）
//   - statusTimer:  30s 状态心跳定时器（由 manager 拥有）
//   - assembler:    流式文本装配器（model/injected 段拼接 + 权威文本修正）
//   - outboundQueue: 会话级出站 FIFO（帧时序唯一收口，coalescing/delayMs）

import { StreamAssembler } from "./stream-assembler.js";
import { OutboundQueue } from "./outbound-queue.js";

export interface TaskEntry {
  taskId: string;
  messageId: string;
  updatedAt: number;
}

export type SessionState =
  | "working"           // dispatcher 存活，agent turn 进行中
  | "waiting-subagent"  // 主 turn 已 idle，等待 subagent 完成
  | "completing"        // final 帧发送中（过渡态）
  | "completed"
  | "failed"
  | "canceled";

export interface SubagentWaitState {
  sessionId: string;
  sessionKey: string;
  taskId: string;
  messageId: string;
  artifactId: string;
  startedAt: number;
  expectedCompletions: number;
  deliveredCompletions: number;
  completionTexts: string[];
  parentSettled: boolean;
  finalizationClaimed: boolean;
  /**
   * final 帧开始交付（deliverSubagentFinalResult 入口）后置位。
   * 捕获窗口以此为准：grace 期间迟到的 announce 文本仍可并入 final；
   * 置位后到达的 sendText 不再捕获（等待态随即清除，回退 push 兜底）。
   */
  finalDeliveryStarted: boolean;
}

export interface SubagentWaitTransition {
  state: SubagentWaitState;
  isComplete: boolean;
  shouldFinalize: boolean;
}

export interface ConversationSession {
  /** A2A sessionId —— 注册表 key。 */
  sessionId: string;
  state: SessionState;
  /** taskId/messageId 链，最后一个为当前任务。 */
  tasks: TaskEntry[];
  /** openclaw 路由 sessionKey（首条消息时绑定）。 */
  sessionKey?: string;
  subagentWaits: SubagentWaitState[];
  /** manager 拥有的 30s 状态心跳定时器。 */
  statusTimer?: NodeJS.Timeout;
  /**
   * 当前 dispatcher 的流式文本装配器（model/injected 段拼接 + 权威文本修正）。
   * 生命周期随 dispatcher：dispatcher 创建时挂载，终态清理时卸载；
   * 挂在这里是为了让工具（display-a2ui-card 等）经 getSession 注入文本段。
   */
  assembler?: StreamAssembler;
  /** 会话级出站队列：所有出站帧的时序收口点，生命周期随 session。 */
  outboundQueue: OutboundQueue;
  lastActivityAt: number;
}

export function createConversationSession(sessionId: string): ConversationSession {
  return {
    sessionId,
    state: "working",
    tasks: [],
    subagentWaits: [],
    outboundQueue: new OutboundQueue(sessionId),
    lastActivityAt: Date.now(),
  };
}

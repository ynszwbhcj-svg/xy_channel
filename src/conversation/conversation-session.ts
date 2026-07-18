// 对话管理层 —— 会话状态对象定义。
//
// ConversationSession 是对话管理层的核心状态载体，收拢了重构前散落在
// task-manager / subagent-wait-state / reply-dispatcher 闭包中的会话状态：
//   - tasks:        session 的 taskId/messageId 链（吸收自 task-manager）
//   - sessionKey:   openclaw 路由 sessionKey（吸收自 sessionKeyMap）
//   - subagentWaits: subagent 等待态（吸收自 subagent-wait-state）
//   - statusTimer:  30s 状态心跳定时器（由 manager 拥有）

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
  lastActivityAt: number;
}

export function createConversationSession(sessionId: string): ConversationSession {
  return {
    sessionId,
    state: "working",
    tasks: [],
    subagentWaits: [],
    lastActivityAt: Date.now(),
  };
}

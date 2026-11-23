// 低版本链路（legacy）增量文本下发跟踪器。
//
// 高版本链路正文/思考帧为 append:false 全量快照（端侧整体替换，含
// canonical 权威补齐）；低版本链路（app_ver < 11.7.10.300，见
// legacy/reply-dispatcher）改为 append:true 增量帧：思考和正文在同一
// turn 内叠加展示 —— 模型回 3 轮时最终文本 = A+B+C，每帧只携带相对
// 上一帧的新增部分。本模块按 session 跟踪"已下发文本"，计算下一帧的
// 增量：
//   - 正文（body）：fullText 为"本模型轮累计文本"（不累加模式下跨轮
//     重置，见 conversation/stream-assembler）；不再以已下发文本开头
//     → 判定为新一轮模型回复，基线复位后整段作为增量叠加下发；
//   - 思考（reasoning）：SDK 推送思考块级全量快照，快照延伸部分即增量；
//     新思考块（快照不再延伸已下发内容）整段作为增量叠加；
// turn 结束（final 帧发出）/ 任务链清理 / 会话销毁时释放。
//
// 叶子模块：不依赖 conversation/dispatch 层。

interface DeltaTextState {
  /** 正文：本模型轮已下发的累计文本（跨轮边界复位）。 */
  bodySent: string;
  /** 思考：已下发的累计快照（同 turn 内跨思考块叠加）。 */
  reasoningSent: string;
}

/** sessionId → 本会话增量下发状态。 */
const stateBySession = new Map<string, DeltaTextState>();

function getOrCreateState(sessionId: string): DeltaTextState {
  let state = stateBySession.get(sessionId);
  if (!state) {
    state = { bodySent: "", reasoningSent: "" };
    stateBySession.set(sessionId, state);
  }
  return state;
}

/**
 * 计算正文增量：fullText 相对已下发内容的新增部分。
 * fullText 延伸已下发内容时增量为延伸段；不再延伸（跨模型轮重置 /
 * canonical 权威改写）时判定新一轮，已下发基线复位，整段作为增量叠加。
 */
export function computeBodyDelta(sessionId: string, fullText: string): string {
  const state = getOrCreateState(sessionId);
  if (state.bodySent && fullText.startsWith(state.bodySent)) {
    const delta = fullText.slice(state.bodySent.length);
    state.bodySent = fullText;
    return delta;
  }
  state.bodySent = fullText;
  return fullText;
}

/**
 * 计算思考增量：SDK 思考块全量快照相对已下发快照的延伸部分；
 * 新思考块（快照不再延伸）整段作为增量叠加。
 */
export function computeReasoningDelta(sessionId: string, snapshot: string): string {
  const state = getOrCreateState(sessionId);
  if (state.reasoningSent && snapshot.startsWith(state.reasoningSent)) {
    const delta = snapshot.slice(state.reasoningSent.length);
    state.reasoningSent = snapshot;
    return delta;
  }
  state.reasoningSent = snapshot;
  return snapshot;
}

/** 释放指定会话的增量状态（turn 结束 / 任务链清理 / 会话销毁时调用）。幂等。 */
export function releaseDeltaTextTracker(sessionId: string): void {
  stateBySession.delete(sessionId);
}

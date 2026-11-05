// 思考文本分段注册表。
//
// 端侧按 streamingTextId 聚合渲染流式文本段，同一 id 的内容放在一起展示。
// SDK onReasoningStream 推送的是思考块级全量快照（append:false 语义），
// 跨分段边界（工具调用/返回，streamingTextId 轮换）续流时，快照仍包含
// 边界前已以旧 id 下发的文本 —— 直接转发会让前段文本在新 id 下重复展示。
// 因此按 taskId 维护思考分段状态：
//   - cutBase：分段基线，即旧 id 段已闭合的文本前缀。分段边界处锁存
//     （cutReasoningSegment；尚无正文段落的边界不拆分、不锁存，见
//     conversation-manager.rotateStreamingTextSegment），后续快照先剥离
//     该前缀，只下发边界后增量段；
//   - 快照不再以 cutBase 开头 → 判定为 SDK 侧新思考块，基线复位、全量下发；
//   - open：当前在役 id 下是否有未闭合的思考流块（已下发思考帧且尚未发出
//     该段的 lastChunk=true 帧）。onReasoningStream 置位；思考块结束标记帧
//     （onReasoningEnd）与分段边界收尾帧（rotateStreamingTextSegment）
//     的决策点复位；
//   - lastSegment：最近一次应下发的段文本（快照剥离基线后的增量段全量），
//     供思考块结束标记帧 / 分段边界收尾帧携带完整段文本。
// turn 结束（final 帧发出）或会话销毁时释放，与 streamingTextId 同生命周期。
//
// 叶子模块：不依赖 conversation/dispatch 层，formatter / conversation-manager /
// reply-dispatcher 均可安全 import（避免循环依赖）。

interface ReasoningSegmentState {
  /** SDK 思考块最近一次全量快照（原始文本，未剥离分段基线）。 */
  lastFull: string;
  /** 分段基线：旧 id 段已闭合的文本前缀，新 id 的思考帧不得再携带。 */
  cutBase: string;
  /** 最近一次应下发的思考段文本（lastFull 剥离 cutBase 后的增量段全量）。 */
  lastSegment: string;
  /** 当前在役 id 下是否有未闭合的思考流块。 */
  open: boolean;
}

/** taskId → 本 turn 的思考分段状态。 */
const reasoningSegmentByTask = new Map<string, ReasoningSegmentState>();

/**
 * 记录一帧思考流全量快照，返回当前 id 段应下发的段文本（剥离分段基线后
 * 的增量段）。快照不再以基线开头时判定为 SDK 侧新思考块，基线复位、全量
 * 下发。段文本非空时刷新 lastSegment 并标记当前 id 的思考流块未闭合；
 * 段文本为空（边界切分后 SDK 重放的旧段内容）时保留上次段文本，调用方
 * 应跳过本次下发。
 */
export function noteReasoningSnapshot(taskId: string, fullText: string): string {
  let state = reasoningSegmentByTask.get(taskId);
  if (!state) {
    state = { lastFull: "", cutBase: "", lastSegment: "", open: false };
    reasoningSegmentByTask.set(taskId, state);
  }
  state.lastFull = fullText;
  let segment: string;
  if (fullText.startsWith(state.cutBase)) {
    segment = fullText.slice(state.cutBase.length);
  } else {
    // 快照不再以基线开头 → SDK 侧新思考块：基线复位，全量下发
    state.cutBase = "";
    segment = fullText;
  }
  if (segment.length > 0) {
    state.lastSegment = segment;
    state.open = true;
  }
  return segment;
}

/** 读取最近一次应下发的思考段文本（收尾帧 / 结束标记帧携带）；未登记返回 ""。 */
export function peekReasoningSegmentText(taskId: string): string {
  return reasoningSegmentByTask.get(taskId)?.lastSegment ?? "";
}

/** 查询当前在役 id 下是否有未闭合的思考流块。 */
export function isReasoningSegmentOpen(taskId: string): boolean {
  return reasoningSegmentByTask.get(taskId)?.open ?? false;
}

/**
 * 闭合当前思考流块。在块结束的决策点同步调用（onReasoningEnd /
 * rotateStreamingTextSegment 的思考收尾），不等在途帧 drain，保证不受
 * 出站队列时序影响。
 */
export function closeReasoningSegment(taskId: string): void {
  const state = reasoningSegmentByTask.get(taskId);
  if (state) state.open = false;
}

/**
 * 分段边界锁存基线：已下发的快照全文成为旧 id 段前缀，后续快照只下发
 * 增量段。无论边界处是否发出思考收尾帧都应调用 —— id 即将轮换，新 id 的
 * 思考帧不得再携带边界前文本。lastFull 为空（尚无思考内容）时 no-op。
 */
export function cutReasoningSegment(taskId: string): void {
  const state = reasoningSegmentByTask.get(taskId);
  if (!state || state.lastFull.length === 0) return;
  state.cutBase = state.lastFull;
  state.lastSegment = "";
}

/** 释放指定 taskId 的思考分段状态（turn 结束 / 会话销毁时调用）。幂等。 */
export function releaseReasoningSegment(taskId: string): void {
  reasoningSegmentByTask.delete(taskId);
}

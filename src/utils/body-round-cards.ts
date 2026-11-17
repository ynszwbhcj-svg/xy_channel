// 正文轮次配对状态卡注册表（高版本链路）。
//
// 每一轮正文（一个正文文本消息）配一对状态卡：
//   - open 卡：正文首帧下发之前发出（text="生成回复"，isFinal=false），
//     认领一个新展示槽位（claimStatusCardSeqForBodyRound），本轮正文帧落在
//     同一槽位；thinkIndex 携带本 turn 已闭合思考块的槽位快照（端侧据此
//     折叠已发送的思考块）；
//   - close 卡：本轮正文结束、下一轮正文开始之后（下一轮正文帧入队之前）
//     发出（text="生成回复已完成"，isFinal=true），taskUniqIndexId 复用
//     open 卡的槽位，thinkIndex=[已闭合思考块槽位..., 完成轮正文的槽位]
//     （端侧一并折叠思考块与该轮正文）；最后一轮正文没有"下一轮"，close
//     卡由 turn 终态序列补发（不携带 thinkIndex —— 最后一轮正文保持展开）。
//
// 本模块只维护记账状态：已闭合思考块槽位列表（open 卡 thinkIndex 数据源）
// 与当前未闭合正文轮次的 open 卡槽位（close 卡复用）。下发逻辑见
// conversation-manager.maybeEnqueueBodyRoundStartCards / 终态序列。
// turn 结束（final 帧发出）或会话销毁时释放。
//
// 叶子模块：不依赖 conversation/dispatch 层。

interface BodyRoundCardsState {
  /** 本 turn 已闭合思考块的展示槽位（字符串化，保序去重）。 */
  reasoningSlots: string[];
  /** 当前未闭合正文轮次的 open 卡槽位；无未闭合轮次为 undefined。 */
  openRoundCardIndex?: number;
}

/** taskId → 本 turn 的正文轮次卡片状态。 */
const stateByTask = new Map<string, BodyRoundCardsState>();

function getOrCreateState(taskId: string): BodyRoundCardsState {
  let state = stateByTask.get(taskId);
  if (!state) {
    state = { reasoningSlots: [] };
    stateByTask.set(taskId, state);
  }
  return state;
}

/**
 * 记录一个闭合思考块的展示槽位：在思考块结束的决策点同步调用
 * （onReasoningEnd / 分段边界思考收尾 / 思考→正文切换收尾），
 * 取思考块开块时锁存的序号。同一值重复出现时只保留一个（同 seq 即同一块）。
 */
export function markReasoningBlockClosed(taskId: string, taskUniqIndexId: number): void {
  const state = getOrCreateState(taskId);
  const value = String(taskUniqIndexId);
  if (!state.reasoningSlots.includes(value)) {
    state.reasoningSlots.push(value);
  }
}

/** 读取本 turn 已闭合思考块的槽位快照（open 卡 thinkIndex 组装用，不清除）。 */
export function peekClosedReasoningSlots(taskId: string): string[] {
  return [...(stateByTask.get(taskId)?.reasoningSlots ?? [])];
}

/** 登记新一轮正文的 open 卡槽位（open 卡入队时调用）。 */
export function openBodyRound(taskId: string, cardIndex: number): void {
  getOrCreateState(taskId).openRoundCardIndex = cardIndex;
}

/** 取出并清除当前未闭合正文轮次的 open 卡槽位（close 卡下发点调用）；无则 undefined。 */
export function takeOpenBodyRoundCardIndex(taskId: string): number | undefined {
  const state = stateByTask.get(taskId);
  const index = state?.openRoundCardIndex;
  if (state) {
    state.openRoundCardIndex = undefined;
  }
  return index;
}

/** 释放指定 taskId 的轮次卡片状态（turn 结束 / 会话销毁时调用）。幂等。 */
export function releaseBodyRoundCards(taskId: string): void {
  stateByTask.delete(taskId);
}

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
  /** 待捎带的前一轮文本块槽位（lastChunk 收尾决策点登记）。 */
  carrySlot?: string;
  /** 前一轮文本块的 lastChunk 收尾帧已实际发出。 */
  carryCloseSent?: boolean;
  /** 下一个文本消息已实际发出（可随工具卡捎带）。 */
  carryArmed?: boolean;
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

// ── 工具状态卡 thinkIndex 捎带 ─────────────────────────────────────
//
// 前一轮文本块（思考段 / 正文段）的 lastChunk 收尾帧发完、且下一个文本
// 消息已发出之后，其后第一张工具状态卡（未显式携带 thinkIndex 的
// sendExecuteStatusCard）携带该块的 taskUniqIndexId 作为 thinkIndex，
// 取一次消费一次。与正文轮次配对卡（open/close 卡）的 thinkIndex 可能
// 重合 —— 刻意不去重：配对卡是轮次语义的权威下发，本捎带是更早触达
// 端侧的折叠提示。
//
// 两段确认均按"实际发出"判定（formatter 的 drain 发送点置位），而非决策
// 点/入队点：保证卡片落在下一个文本消息之后到达端侧。

/**
 * 文本块 lastChunk 收尾决策点登记待捎带槽位（思考块结束 / 分段边界正文
 * 冲刷 / 思考→正文切换收尾）。新登记覆盖旧值：只捎带"前一轮"（最近的
 * 已完成块），更早的块由配对卡 thinkIndex 覆盖。
 */
export function noteTextBlockClosedForToolCarry(taskId: string, taskUniqIndexId: number): void {
  const state = getOrCreateState(taskId);
  state.carrySlot = String(taskUniqIndexId);
  state.carryCloseSent = false;
  state.carryArmed = false;
}

/** lastChunk=true 文本收尾帧实际发出后调用（formatter drain 发送点）。 */
export function noteTextCloseFrameSentForToolCarry(taskId: string): void {
  const state = stateByTask.get(taskId);
  if (state?.carrySlot !== undefined) {
    state.carryCloseSent = true;
  }
}

/** 非收尾文本帧（下一块的过程帧）实际发出后调用（formatter drain 发送点）。 */
export function noteTextMessageSentForToolCarry(taskId: string): void {
  const state = stateByTask.get(taskId);
  if (state?.carrySlot !== undefined && state.carryCloseSent === true) {
    state.carryArmed = true;
  }
}

/**
 * 读取并消费工具状态卡待捎带的 thinkIndex：仅当【前一轮块收尾帧已发出
 * 且下一个文本消息已发出】时返回 [前一轮块槽位]，否则 undefined；返回后
 * 即消费，后续卡片不再重复携带（直到再有块完成上述两段确认）。
 */
export function takeToolCardThinkIndex(taskId: string): string[] | undefined {
  const state = stateByTask.get(taskId);
  if (!state || state.carrySlot === undefined || state.carryArmed !== true) {
    return undefined;
  }
  const slot = state.carrySlot;
  state.carrySlot = undefined;
  state.carryCloseSent = false;
  state.carryArmed = false;
  return [slot];
}

import { logger } from "./utils/logger.js";
import { randomUUID } from "crypto";

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
  finalizationClaimed?: boolean;
  stopHeartbeat?: () => void;
}

export interface SubagentWaitTransition {
  state: SubagentWaitState;
  isComplete: boolean;
  shouldFinalize: boolean;
}

const WAIT_TTL_MS = 30 * 60 * 1000;

const globalState = globalThis as Record<string, unknown>;
if (!globalState.__xySubagentWaitStates) {
  globalState.__xySubagentWaitStates = new Map<string, SubagentWaitState[]>();
}

const waitStates = globalState.__xySubagentWaitStates as Map<string, SubagentWaitState[] | SubagentWaitState>;
if (!globalState.__xySubagentExpectedCompletionCounts) {
  globalState.__xySubagentExpectedCompletionCounts = new Map<string, number>();
}
const expectedCompletionCounts = globalState.__xySubagentExpectedCompletionCounts as Map<string, number>;

function waitKey(sessionId: string, taskId: string): string {
  return `${sessionId}::${taskId}`;
}

function isExpired(state: SubagentWaitState): boolean {
  return Date.now() - state.startedAt > WAIT_TTL_MS;
}

function isComplete(state: SubagentWaitState): boolean {
  return state.deliveredCompletions >= Math.max(1, state.expectedCompletions);
}

function claimFinalizationIfReady(state: SubagentWaitState): boolean {
  if (state.finalizationClaimed) {
    return false;
  }
  if (!state.parentSettled || !isComplete(state)) {
    return false;
  }
  state.finalizationClaimed = true;
  return true;
}

export function markSubagentWaitStarted(
  state: Omit<SubagentWaitState, "artifactId" | "startedAt" | "expectedCompletions" | "deliveredCompletions" | "completionTexts" | "parentSettled" | "finalizationClaimed"> &
    Partial<Pick<SubagentWaitState, "expectedCompletions" | "deliveredCompletions">>,
): SubagentWaitState | null {
  const expectedCompletions =
    state.expectedCompletions ?? expectedCompletionCounts.get(waitKey(state.sessionId, state.taskId)) ?? 0;
  if (expectedCompletions <= 0) {
    logger.withContext(state.sessionId, state.taskId).log(
      `[SUBAGENT-WAIT] Skipping wait start because no sessions_spawn completion was expected`,
    );
    return null;
  }
  const nextState: SubagentWaitState = {
    ...state,
    artifactId: randomUUID(),
    expectedCompletions: Math.max(1, expectedCompletions),
    deliveredCompletions: state.deliveredCompletions ?? 0,
    completionTexts: [],
    parentSettled: false,
    finalizationClaimed: false,
    startedAt: Date.now(),
  };
  const existing = getSubagentWaitStates(state.sessionId);
  const replaced = existing.filter((entry) => entry.taskId !== state.taskId);
  replaced.push(nextState);
  replaced.sort((a, b) => a.startedAt - b.startedAt);
  waitStates.set(state.sessionId, replaced);
  logger.withContext(state.sessionId, state.taskId).log(
    `[SUBAGENT-WAIT] Started waiting for subagent completion, sessionKey=${state.sessionKey}, expected=${expectedCompletions}, pending=${replaced.length}`,
  );
  return nextState;
}

export function markSubagentCompletionExpected(sessionId: string, taskId: string): number {
  const key = waitKey(sessionId, taskId);
  const next = Math.max(1, (expectedCompletionCounts.get(key) ?? 0) + 1);
  expectedCompletionCounts.set(key, next);

  const states = getSubagentWaitStates(sessionId);
  const state = states.find((entry) => entry.taskId === taskId);
  if (state) {
    state.expectedCompletions = Math.max(state.expectedCompletions, next);
    waitStates.set(sessionId, states);
  }

  logger.withContext(sessionId, taskId).log(`[SUBAGENT-WAIT] Expected subagent completions=${next}`);
  return next;
}

export function markSubagentCompletionDelivered(
  sessionId: string,
  taskId: string,
  text?: string,
): SubagentWaitTransition | null {
  const states = getSubagentWaitStates(sessionId);
  const state = states.find((entry) => entry.taskId === taskId);
  if (!state) {
    logger.withContext(sessionId, taskId).log(`[SUBAGENT-WAIT] No wait state matched for completion delivery`);
    return null;
  }
  state.deliveredCompletions += 1;
  if (text?.trim()) {
    state.completionTexts.push(text);
  }
  const complete = isComplete(state);
  const shouldFinalize = claimFinalizationIfReady(state);
  waitStates.set(sessionId, states);
  logger.withContext(sessionId, taskId).log(
    `[SUBAGENT-WAIT] Completion delivered count=${state.deliveredCompletions}/${state.expectedCompletions}, complete=${complete}, shouldFinalize=${shouldFinalize}`,
  );
  return { state, isComplete: complete, shouldFinalize };
}

export function markSubagentWaitParentSettled(sessionId: string, taskId: string): SubagentWaitTransition | null {
  const states = getSubagentWaitStates(sessionId);
  const state = states.find((entry) => entry.taskId === taskId);
  if (!state) {
    logger.withContext(sessionId, taskId).log(`[SUBAGENT-WAIT] No wait state matched for parent settled mark`);
    return null;
  }
  state.parentSettled = true;
  const complete = isComplete(state);
  const shouldFinalize = claimFinalizationIfReady(state);
  waitStates.set(sessionId, states);
  logger.withContext(sessionId, taskId).log(
    `[SUBAGENT-WAIT] Parent dispatcher settled while waiting, complete=${complete}, shouldFinalize=${shouldFinalize}`,
  );
  return { state, isComplete: complete, shouldFinalize };
}

export function attachSubagentWaitHeartbeat(
  sessionId: string,
  taskId: string,
  stopHeartbeat: () => void,
): void {
  const states = getSubagentWaitStates(sessionId);
  const state = states.find((entry) => entry.taskId === taskId);
  if (!state) {
    logger.withContext(sessionId, taskId).log(`[SUBAGENT-WAIT] No wait state matched for heartbeat attachment`);
    return;
  }
  state.stopHeartbeat = stopHeartbeat;
  waitStates.set(sessionId, states);
  logger.withContext(sessionId, taskId).log(`[SUBAGENT-WAIT] Attached waiting heartbeat cleanup`);
}

export function getSubagentWaitStates(sessionId: string): SubagentWaitState[] {
  const raw = waitStates.get(sessionId);
  if (!raw) return [];
  const states = Array.isArray(raw) ? raw : [raw];
  const active = states.filter((state) => {
    if (!isExpired(state)) return true;
    state.stopHeartbeat?.();
    logger.withContext(sessionId, state.taskId).log(`[SUBAGENT-WAIT] Expired wait state cleared`);
    return false;
  });
  if (active.length > 0) {
    waitStates.set(sessionId, active);
  } else {
    waitStates.delete(sessionId);
  }
  return active;
}

export function getSubagentWaitState(sessionId: string, taskId?: string): SubagentWaitState | null {
  const states = getSubagentWaitStates(sessionId);
  if (states.length === 0) return null;
  if (taskId) {
    return states.find((state) => state.taskId === taskId) ?? null;
  }
  // OpenClaw may announce completion with only sessionId; use FIFO so later user messages do not steal the result.
  return states[0] ?? null;
}

export function hasSubagentWaitState(sessionId: string, taskId?: string): boolean {
  return getSubagentWaitState(sessionId, taskId) !== null;
}

export function clearSubagentWaitState(
  sessionId: string,
  reason: string,
  taskId?: string,
): SubagentWaitState | null {
  const states = getSubagentWaitStates(sessionId);
  if (states.length === 0) return null;
  const index = taskId ? states.findIndex((state) => state.taskId === taskId) : 0;
  if (index < 0) {
    logger.withContext(sessionId, taskId ?? "").log(`[SUBAGENT-WAIT] No wait state matched for clear, reason=${reason}`);
    return null;
  }
  const [state] = states.splice(index, 1);
  state.stopHeartbeat?.();
  if (states.length > 0) {
    waitStates.set(sessionId, states);
  } else {
    waitStates.delete(sessionId);
  }
  expectedCompletionCounts.delete(waitKey(sessionId, state.taskId));
  logger.withContext(sessionId, state.taskId).log(
    `[SUBAGENT-WAIT] Cleared wait state, reason=${reason}, remaining=${states.length}`,
  );
  return state;
}

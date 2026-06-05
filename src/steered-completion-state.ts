import { logger } from "./utils/logger.js";

export interface SteeredCompletionState {
  sessionId: string;
  sessionKey: string;
  taskId: string;
  messageId: string;
  startedAt: number;
}

const STEERED_COMPLETION_TTL_MS = 30 * 60 * 1000;

const globalState = globalThis as Record<string, unknown>;
if (!globalState.__xySteeredCompletionStates) {
  globalState.__xySteeredCompletionStates = new Map<string, SteeredCompletionState[]>();
}

const completionStates = globalState.__xySteeredCompletionStates as Map<string, SteeredCompletionState[]>;

function isExpired(state: SteeredCompletionState): boolean {
  return Date.now() - state.startedAt > STEERED_COMPLETION_TTL_MS;
}

export function markSteeredCompletionPending(state: Omit<SteeredCompletionState, "startedAt">): void {
  const nextState: SteeredCompletionState = {
    ...state,
    startedAt: Date.now(),
  };
  const existing = getSteeredCompletionStates(state.sessionId);
  const replaced = existing.filter((entry) => entry.taskId !== state.taskId);
  replaced.push(nextState);
  replaced.sort((a, b) => a.startedAt - b.startedAt);
  completionStates.set(state.sessionId, replaced);
  logger.withContext(state.sessionId, state.taskId).log(
    `[STEERED-COMPLETION] Started waiting for steered result, pending=${replaced.length}`,
  );
}

export function getSteeredCompletionStates(sessionId: string): SteeredCompletionState[] {
  const states = completionStates.get(sessionId) ?? [];
  const active = states.filter((state) => {
    if (!isExpired(state)) return true;
    logger.withContext(sessionId, state.taskId).log(`[STEERED-COMPLETION] Expired pending state cleared`);
    return false;
  });
  if (active.length > 0) {
    completionStates.set(sessionId, active);
  } else {
    completionStates.delete(sessionId);
  }
  return active;
}

export function getSteeredCompletionState(sessionId: string, taskId?: string): SteeredCompletionState | null {
  const states = getSteeredCompletionStates(sessionId);
  if (states.length === 0) return null;
  if (taskId) {
    return states.find((state) => state.taskId === taskId) ?? null;
  }
  return states[0] ?? null;
}

export function clearSteeredCompletionState(
  sessionId: string,
  reason: string,
  taskId?: string,
): SteeredCompletionState | null {
  const states = getSteeredCompletionStates(sessionId);
  if (states.length === 0) return null;
  const index = taskId ? states.findIndex((state) => state.taskId === taskId) : 0;
  if (index < 0) {
    logger.withContext(sessionId, taskId ?? "").log(
      `[STEERED-COMPLETION] No pending state matched for clear, reason=${reason}`,
    );
    return null;
  }
  const [state] = states.splice(index, 1);
  if (states.length > 0) {
    completionStates.set(sessionId, states);
  } else {
    completionStates.delete(sessionId);
  }
  logger.withContext(sessionId, state.taskId).log(
    `[STEERED-COMPLETION] Cleared pending state, reason=${reason}, remaining=${states.length}`,
  );
  return state;
}

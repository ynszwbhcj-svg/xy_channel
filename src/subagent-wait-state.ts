// Subagent wait state manager.
//
// Tracks sessions that are waiting for subagent completions after sessions_yield.
// Subagent spawn/end is detected via subagent_spawned / subagent_ended hooks (index.ts).
// Completion delivery is intercepted in xyOutbound.sendText (outbound.ts).
//
// Isolation: xyOutbound.sendText also serves cron pushes and normal message-tool calls.
// Guards ensure these paths never collide with subagent result interception:
//   1. ALS context guard — subagent completions arrive with ALS null
//   2. Wait state match — only sessions that have yielded have a wait state
//   3. TaskId match — subagent delivery's "to" is a bare sessionId, enhanced via wait state
//
// TTL: wait states expire after WAIT_TTL_MS (30 min) to avoid stale leaks.
// Only one finalization path wins via finalizationClaimed flag.

import { randomUUID } from "crypto";
import { logger } from "./utils/logger.js";

// ─── Types ────────────────────────────────────────────────────

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
  stopHeartbeat?: () => void;
}

export interface SubagentWaitTransition {
  state: SubagentWaitState;
  isComplete: boolean;
  shouldFinalize: boolean;
}

// ─── Global state ──────────────────────────────────────────────

const WAIT_TTL_MS = 30 * 60 * 1000; // 30 minutes

const _g = globalThis as Record<string, unknown>;
if (!_g.__xySubagentWaitStates) {
  _g.__xySubagentWaitStates = new Map<string, SubagentWaitState[]>();
}
if (!_g.__xySessionKeyToSessionId) {
  _g.__xySessionKeyToSessionId = new Map<string, { sessionId: string; taskId: string; messageId: string }>();
}
if (!_g.__xyCachedXYConfig) {
  _g.__xyCachedXYConfig = null;
}

/**
 * Cache the resolved XY config globally so the subagent_ended hook
 * can use it without needing raw ClawdbotConfig (which may not be
 * available on the runtime object in hook contexts).
 */
export function cacheXYConfig(config: unknown): void {
  _g.__xyCachedXYConfig = config;
}

export function getCachedXYConfig(): unknown {
  return _g.__xyCachedXYConfig;
}

const waitStates = _g.__xySubagentWaitStates as Map<string, SubagentWaitState[]>;
const sessionKeyMap = _g.__xySessionKeyToSessionId as Map<string, { sessionId: string; taskId: string; messageId: string }>;

// ─── Helpers ───────────────────────────────────────────────────

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
  if (state.finalizationClaimed) return false;
  if (!state.parentSettled || !isComplete(state)) return false;
  state.finalizationClaimed = true;
  return true;
}

// ─── SessionKey ↔ SessionId mapping ────────────────────────────

/**
 * Register a mapping from openclaw sessionKey to A2A sessionId/taskId.
 * Called in bot.ts when a new message dispatch begins.
 */
export function registerSessionKeyMapping(
  sessionKey: string,
  sessionId: string,
  taskId: string,
  messageId: string,
): void {
  if (!sessionKey || !sessionId) return;
  sessionKeyMap.set(sessionKey, { sessionId, taskId, messageId });
}

/**
 * Look up the A2A sessionId for a given openclaw sessionKey.
 * Used in hooks (index.ts) to translate requesterSessionKey to A2A sessionId.
 */
export function resolveSessionIdFromSessionKey(
  sessionKey: string,
): { sessionId: string; taskId: string; messageId: string } | null {
  return sessionKeyMap.get(sessionKey) ?? null;
}

/**
 * Remove a sessionKey→sessionId mapping (cleanup when wait state resolved).
 */
export function unregisterSessionKeyMapping(sessionKey: string): void {
  sessionKeyMap.delete(sessionKey);
}

// ─── Wait state management ─────────────────────────────────────

function getStatesArray(sessionId: string): SubagentWaitState[] {
  const raw = waitStates.get(sessionId);
  if (!raw) return [];
  const active = raw.filter((s) => {
    if (!isExpired(s)) return true;
    s.stopHeartbeat?.();
    logger.withContext(sessionId, s.taskId).log(
      `[SUBAGENT-WAIT] Expired wait state cleared, expected=${s.expectedCompletions}, delivered=${s.deliveredCompletions}`,
    );
    return false;
  });
  if (active.length > 0) {
    waitStates.set(sessionId, active);
  } else {
    waitStates.delete(sessionId);
  }
  return active;
}

/**
 * Called from subagent_spawned hook. Increments expected completion count.
 * If no wait state exists yet, creates one (sessions_spawn may happen before sessions_yield).
 */
export function markSubagentSpawned(
  sessionKey: string,
): number {
  const mapped = resolveSessionIdFromSessionKey(sessionKey);
  if (!mapped) {
    logger.log(`[SUBAGENT-WAIT] No session mapping for sessionKey=${sessionKey.slice(0, 30)}`);
    return 0;
  }

  const { sessionId, taskId, messageId } = mapped;
  const states = getStatesArray(sessionId);
  let state = states.find((s) => s.taskId === taskId);

  if (!state) {
    state = {
      sessionId,
      sessionKey,
      taskId,
      messageId,
      artifactId: randomUUID(),
      startedAt: Date.now(),
      expectedCompletions: 0,
      deliveredCompletions: 0,
      completionTexts: [],
      parentSettled: false,
      finalizationClaimed: false,
    };
    states.push(state);
  }

  state.expectedCompletions = Math.max(1, state.expectedCompletions + 1);
  waitStates.set(sessionId, states);

  logger.withContext(sessionId, taskId).log(
    `[SUBAGENT-WAIT] Subagent spawned, expected=${state.expectedCompletions}`,
  );
  return state.expectedCompletions;
}

/**
 * Called from subagent_ended hook. Marks a subagent run as ended AND
 * counts it as a delivery. This is the primary completion tracking
 * mechanism because subagent completions may not route through
 * xyOutbound.sendText (they go through openclaw's internal gateway
 * agent path with potentially deliver=false).
 *
 * Returns transition with shouldFinalize if all completions have ended.
 */
export function markSubagentEnded(
  sessionKey: string,
): SubagentWaitTransition | null {
  const mapped = resolveSessionIdFromSessionKey(sessionKey);
  if (!mapped) return null;

  const { sessionId, taskId } = mapped;
  const states = getStatesArray(sessionId);
  const state = states.find((s) => s.taskId === taskId);
  if (!state) {
    logger.withContext(sessionId, taskId).log(
      `[SUBAGENT-WAIT] Subagent ended but no wait state found`,
    );
    return null;
  }

  state.deliveredCompletions += 1;
  const complete = isComplete(state);
  const shouldFinalize = claimFinalizationIfReady(state);
  waitStates.set(sessionId, states);

  logger.withContext(sessionId, taskId).log(
    `[SUBAGENT-WAIT] Subagent ended, delivered=${state.deliveredCompletions}/${state.expectedCompletions}, complete=${complete}, shouldFinalize=${shouldFinalize}`,
  );
  return { state, isComplete: complete, shouldFinalize };
}

/**
 * Called from bot.ts onSettled. Marks parent dispatcher as settled.
 * Returns transition with shouldFinalize if all completions already arrived.
 */
export function markParentSettled(
  sessionId: string,
  taskId: string,
): SubagentWaitTransition | null {
  const states = getStatesArray(sessionId);
  const state = states.find((s) => s.taskId === taskId);
  if (!state) {
    logger.withContext(sessionId, taskId).log(
      `[SUBAGENT-WAIT] No wait state matched for parent settled`,
    );
    return null;
  }

  state.parentSettled = true;
  const complete = isComplete(state);
  const shouldFinalize = claimFinalizationIfReady(state);
  waitStates.set(sessionId, states);

  logger.withContext(sessionId, taskId).log(
    `[SUBAGENT-WAIT] Parent settled, completions=${state.deliveredCompletions}/${state.expectedCompletions}, shouldFinalize=${shouldFinalize}`,
  );
  return { state, isComplete: complete, shouldFinalize };
}

/**
 * Store a completion text snippet captured from xyOutbound.sendText.
 * Does NOT increment delivery count (that's done by markSubagentEnded).
 */
export function addCompletionText(
  sessionId: string,
  taskId: string,
  text: string,
): void {
  const states = getStatesArray(sessionId);
  const state = states.find((s) => s.taskId === taskId);
  if (!state || !text.trim()) return;
  state.completionTexts.push(text.trim());
  waitStates.set(sessionId, states);
}

export function attachHeartbeat(
  sessionId: string,
  taskId: string,
  stopHeartbeat: () => void,
): void {
  const states = getStatesArray(sessionId);
  const state = states.find((s) => s.taskId === taskId);
  if (!state) {
    logger.withContext(sessionId, taskId).log(
      `[SUBAGENT-WAIT] No wait state matched for heartbeat attachment`,
    );
    return;
  }
  state.stopHeartbeat = stopHeartbeat;
  waitStates.set(sessionId, states);
  logger.withContext(sessionId, taskId).log(`[SUBAGENT-WAIT] Heartbeat attached`);
}

// ─── Query functions ───────────────────────────────────────────

export function getWaitState(
  sessionId: string,
  taskId?: string,
): SubagentWaitState | null {
  const states = getStatesArray(sessionId);
  if (states.length === 0) return null;
  if (taskId) {
    return states.find((s) => s.taskId === taskId) ?? null;
  }
  // FIFO: return oldest wait state when taskId not specified
  return states[0] ?? null;
}

export function hasWaitState(sessionId: string, taskId?: string): boolean {
  return getWaitState(sessionId, taskId) !== null;
}

export function clearWaitState(
  sessionId: string,
  reason: string,
  taskId?: string,
): SubagentWaitState | null {
  const states = getStatesArray(sessionId);
  if (states.length === 0) return null;

  const index = taskId
    ? states.findIndex((s) => s.taskId === taskId)
    : 0;
  if (index < 0) {
    logger.withContext(sessionId, taskId ?? "").log(
      `[SUBAGENT-WAIT] No wait state matched for clear, reason=${reason}`,
    );
    return null;
  }

  const [state] = states.splice(index, 1);
  state.stopHeartbeat?.();
  if (states.length > 0) {
    waitStates.set(sessionId, states);
  } else {
    waitStates.delete(sessionId);
  }

  logger.withContext(sessionId, state.taskId).log(
    `[SUBAGENT-WAIT] Cleared wait state, reason=${reason}, remaining=${states.length}`,
  );
  return state;
}

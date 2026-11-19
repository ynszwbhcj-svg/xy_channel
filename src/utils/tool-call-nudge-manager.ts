type ToolCallNudgeState = {
  count: number;
  nudged: boolean;
};

type RecordToolCallResult = {
  count: number;
  shouldNudge: boolean;
};
const DEFAULT_TOOL_CALL_NUDGE_THRESHOLD = 6;

class ToolCallNudgeManager {
  private readonly threshold: number;
  private readonly sessions = new Map<string, ToolCallNudgeState>();

  constructor(threshold = DEFAULT_TOOL_CALL_NUDGE_THRESHOLD) {
    this.threshold = threshold;
  }

  private getSessionState(sessionKey: string): ToolCallNudgeState {
    let state = this.sessions.get(sessionKey);
    if (!state) {
      state = {
        count: 0,
        nudged: false,
      };
      this.sessions.set(sessionKey, state);
    }
    return state;
  }

  recordToolCall(sessionKey: string): RecordToolCallResult {
    const state = this.getSessionState(sessionKey);

    state.count += 1;

    if (!state.nudged && state.count >= this.threshold) {
      state.nudged = true;
      return {
        count: state.count,
        shouldNudge: true,
      };
    }

    return {
      count: state.count,
      shouldNudge: false,
    };
  }

  tryMarkKeywordNudge(sessionKey: string): boolean {
    const state = this.getSessionState(sessionKey);
    if (state.nudged) {
      return false;
    }

    state.nudged = true;
    return true;
  }

  clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }
}

export const TOOL_CALL_NUDGE_THRESHOLD = DEFAULT_TOOL_CALL_NUDGE_THRESHOLD;
export const toolCallNudgeManager = new ToolCallNudgeManager();

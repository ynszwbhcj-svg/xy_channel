/**
 * Serial full turns with a barrier that prevents text steer from overtaking a
 * queued image/model-change turn. The initial turn alone does not block steer.
 */
export function createInboundAdmissionQueue() {
  const sessions = new Map<string, { tail: Promise<void>; barriers: number }>();
  return {
    hasQueued: (sessionId: string): boolean => sessions.has(sessionId),
    hasBarrier: (sessionId: string): boolean => (sessions.get(sessionId)?.barriers ?? 0) > 0,
    enqueue(sessionId: string, task: () => Promise<void>, barrier = false): Promise<void> {
      let state = sessions.get(sessionId);
      if (!state) {
        state = { tail: Promise.resolve(), barriers: 0 };
        sessions.set(sessionId, state);
      }
      const owner = state;
      if (barrier) owner.barriers++;
      const next = owner.tail.then(task, task);
      owner.tail = next;
      const settled = () => {
        if (barrier) owner.barriers--;
        if (sessions.get(sessionId) === owner && owner.tail === next) sessions.delete(sessionId);
      };
      void next.then(settled, settled);
      return next;
    },
    clear: () => sessions.clear(),
  };
}

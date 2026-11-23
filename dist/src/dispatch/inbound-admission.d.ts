/**
 * Serial full turns with a barrier that prevents text steer from overtaking a
 * queued image/model-change turn. The initial turn alone does not block steer.
 */
export declare function createInboundAdmissionQueue(): {
    hasQueued: (sessionId: string) => boolean;
    hasBarrier: (sessionId: string) => boolean;
    enqueue(sessionId: string, task: () => Promise<void>, barrier?: boolean): Promise<void>;
    clear: () => void;
};

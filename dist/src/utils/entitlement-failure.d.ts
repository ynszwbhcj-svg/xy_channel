import type { TaskEntry } from "../conversation/conversation-session.js";
export declare function trackEntitlementFailure(task: TaskEntry): (result: {
    stopReason?: string;
    errorMessage?: unknown;
} | undefined) => void;
export declare function rewriteEntitlementFailureText(text: string, task: TaskEntry | null): string;

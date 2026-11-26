import type { TaskEntry } from "../conversation/conversation-session.js";

const ENTITLEMENT_FAILURE_TEXT = "用户权益校验失败";
const ENTITLEMENT_FAILURE_REPLY = "本次任务未能通过权益校验。请查看小艺 Work 积分和会员权益后再试。";
const GENERIC_MODEL_FAILURE = /^LLM request failed\.?$/i;

// The task entry owns the lifetime of this state, including canceled tasks.
const latestModelResults = new WeakMap<TaskEntry, {
  entitlementFailed: boolean;
  replySelected: boolean;
}>();

export function trackEntitlementFailure(task: TaskEntry) {
  // A new model call replaces the prior result for this task. A late result
  // only updates its own record and cannot overwrite a newer call's outcome.
  const outcome = { entitlementFailed: false, replySelected: false };
  latestModelResults.set(task, outcome);
  return (result: { stopReason?: string; errorMessage?: unknown } | undefined): void => {
    outcome.entitlementFailed = result?.stopReason === "error" &&
      typeof result.errorMessage === "string" && result.errorMessage.trim() === ENTITLEMENT_FAILURE_TEXT;
  };
}

export function selectEntitlementFailureReply(text: string, task: TaskEntry | null): string | undefined {
  const outcome = task ? latestModelResults.get(task) : undefined;
  if (!outcome?.entitlementFailed || !GENERIC_MODEL_FAILURE.test(text.trim())) return;
  outcome.replySelected = true;
  return ENTITLEMENT_FAILURE_REPLY;
}

export function getSelectedEntitlementFailureReply(task: TaskEntry | null): string | undefined {
  if (task && latestModelResults.get(task)?.replySelected) return ENTITLEMENT_FAILURE_REPLY;
}

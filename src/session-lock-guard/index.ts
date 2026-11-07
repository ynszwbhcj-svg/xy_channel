import { GatewayLockGuard, type AgentEventLike, type GuardDeps, type GuardOptions } from "./guard.js";

export * from "./lock-error.js";
export * from "./policy.js";
export * from "./supervisor.js";
export * from "./guard.js";

export interface RegisterParams {
  /** openclaw plugin-sdk/agent-harness-runtime 的 onAgentEvent。 */
  onAgentEvent: (listener: (evt: AgentEventLike) => void) => () => void;
  /** 接 api.on("gateway_start", ...)。 */
  registerGatewayStartHook: (callback: () => void) => void;
  deps: GuardDeps;
  options?: GuardOptions;
}

export function registerGatewayLockGuard(params: RegisterParams): {
  guard: GatewayLockGuard;
  dispose: () => void;
} {
  const guard = new GatewayLockGuard(params.deps, params.options);
  const unsubscribe = params.onAgentEvent((evt) => {
    void guard.handleAgentEvent(evt).catch((err: unknown) => {
      // 监听器绝不能把异常抛回 gateway 主流程，否则故障处理本身会变成新故障。
      params.deps.logger.error(`[LOCK-GUARD] listener error: ${String(err)}`);
    });
  });
  params.registerGatewayStartHook(() => guard.markGatewayStarted());

  return {
    guard,
    dispose: () => {
      unsubscribe();
    },
  };
}

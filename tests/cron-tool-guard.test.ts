import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isCronActive: vi.fn(),
}));

vi.mock("../src/tools/session-manager.js", () => ({
  isCronActive: mocks.isCronActive,
}));

import { registerCronToolGuard } from "../src/tools/cron-tool-guard.js";

const TARGET_TOOL = "xiaoyi_append_reference";
type HookHandler = (event: any, ctx: any) => any;

function createHarness() {
  const handlers = new Map<string, HookHandler>();
  const runContexts = new Map<string, unknown>();
  const api = {
    on: vi.fn((name: string, handler: HookHandler) => {
      handlers.set(name, handler);
    }),
    runContext: {
      setRunContext: vi.fn(({ runId, value }: { runId: string; value: unknown }) => {
        runContexts.set(runId, value);
        return true;
      }),
      getRunContext: vi.fn(({ runId }: { runId: string }) => runContexts.get(runId)),
    },
  };

  registerCronToolGuard(api as any);

  const invoke = (name: string, event: any, ctx: any) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Missing ${name} handler`);
    return handler(event, ctx);
  };

  return { api, invoke };
}

describe("cron tool guard", () => {
  beforeEach(() => {
    mocks.isCronActive.mockReset();
    mocks.isCronActive.mockReturnValue(false);
  });

  it("blocks the target tool for an explicit cron run using a persistent session", async () => {
    const { invoke } = createHarness();
    const sessionKey = "agent:main:direct:shared";
    await invoke("before_agent_run", {}, { trigger: "cron", runId: "run-cron", sessionKey });

    const result = await invoke("before_tool_call", {
      toolName: TARGET_TOOL,
      toolCallId: "call-cron",
      params: {},
    }, {
      runId: "run-cron",
      sessionKey,
    });

    expect(result).toEqual({
      block: true,
      blockReason: expect.stringContaining("定时任务场景不支持调用 xiaoyi_append_reference"),
    });
    expect(result.blockReason).toContain("请勿重试");
  });

  it.each([
    "cron:job-1",
    "agent:main:cron:job-1:run:123456",
  ])("keeps the legacy cron sessionKey fallback: %s", async (sessionKey) => {
    const { invoke } = createHarness();

    const result = await invoke("before_tool_call", {
      toolName: TARGET_TOOL,
      runId: "run-legacy",
      params: {},
    }, { sessionKey });

    expect(result).toMatchObject({ block: true });
  });

  it("keeps the existing isCronActive compatibility fallback", async () => {
    mocks.isCronActive.mockReturnValue(true);
    const { invoke } = createHarness();

    const result = await invoke("before_tool_call", {
      toolName: TARGET_TOOL,
      params: {},
    }, { sessionKey: "agent:main:direct:legacy" });

    expect(result).toMatchObject({ block: true });
    expect(mocks.isCronActive).toHaveBeenCalledWith(undefined);
  });

  it("allows other tools during the same cron run", async () => {
    const { invoke } = createHarness();
    await invoke("before_agent_run", {}, { trigger: "cron", runId: "run-cron" });

    const result = await invoke("before_tool_call", {
      toolName: "read",
      params: { path: "/tmp/example.txt" },
    }, { runId: "run-cron", sessionKey: "agent:main:direct:shared" });

    expect(result).toBeUndefined();
  });

  it("allows the target tool in a normal conversation and does not mark the run", async () => {
    const { api, invoke } = createHarness();
    const ctx = { trigger: "user", runId: "run-user", sessionKey: "agent:main:direct:user" };
    await invoke("before_agent_run", {}, ctx);

    const result = await invoke("before_tool_call", {
      toolName: TARGET_TOOL,
      params: {},
    }, ctx);

    expect(result).toBeUndefined();
    expect(api.runContext.setRunContext).not.toHaveBeenCalled();
  });
});

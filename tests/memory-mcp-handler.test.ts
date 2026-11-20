import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withMemoryMcpFixture } from "./support/memory-mcp-cases.js";

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn(), log: vi.fn() }));
vi.mock("../src/formatter.js", () => ({ sendCommand: mocks.sendCommand }));
vi.mock("../src/utils/logger.js", () => ({ logger: {
  log: mocks.log, warn: mocks.log, error: mocks.log,
  withContext: () => ({ log: mocks.log, warn: mocks.log, error: mocks.log }),
} }));
import { handleMemoryQueryEvent } from "../src/memory-query-handler.js";

const config = (memory = true) => ({ channels: { "xiaoyi-channel": {
  apiKey: "test-key", agentId: "test-agent", uid: "test-user", apiId: "test-api", pushId: "test-push",
  ...(memory ? { memory: { backend: "mcp-http" } } : {}),
} } });
const event = (action: string, params = {}) => ({ action, params, sessionId: "test-session", taskId: "task", messageId: action });
function activate(f: any) {
  vi.stubEnv("CELIA_MEMORY_HTTP_URL", f.config.endpoint);
  vi.stubEnv("CELIA_MEMORY_HTTP_TOKEN_FILE", f.tokenFile);
}

describe("MemoryQuery MCP dispatch", () => {
  beforeEach(() => { mocks.sendCommand.mockReset();mocks.log.mockReset(); });
  afterEach(() => vi.unstubAllEnvs());

  it("maps all seven actions and sends final correlated A2A responses", () => withMemoryMcpFixture(async f => {
    activate(f);const cfg = config();
    const events = [event("MemoryStateGet"), event("MemoryStateSet", { body: { memoryState: true } }),
      event("UserMdQuery"), event("MemoryMdQuery"), event("MemoryProfileModify", { instruction: "private edit" }),
      event("MemoryReset", { requestId: "clear-1" }), event("MemoryResetStatus", { requestId: "clear-1" })];
    for (const input of events) {
      const answer = await handleMemoryQueryEvent(input, cfg);
      const sent = mocks.sendCommand.mock.lastCall![0];
      expect(sent).toMatchObject({ sessionId: input.sessionId, taskId: input.taskId, messageId: input.messageId, final: true,
        command: { header: { namespace: "AgentEvent", name: "MemoryQuery" }, payload: { action: input.action, ans: answer } } });
    }
    expect(f.count("initialize")).toBe(1);
    expect(f.count("memory.profile.modify")).toBe(1);
    expect(f.count("memory.profile.reset")).toBe(1);
    expect(f.count("memory.profile.reset.status")).toBe(1);
    expect(mocks.log.mock.calls.flat().join("\n")).not.toMatch(/private|test-key/);
  }));

  it("returns MCP Busy without falling back to workspace Markdown", () => withMemoryMcpFixture(async f => {
    activate(f);
    f.route = (request: any, res: any) => {
      if (request.method !== "memory.profile.get") return false;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { status: -5, result: null } }));return true;
    };
    const answer = await handleMemoryQueryEvent(event("UserMdQuery"), config());
    expect(answer).toMatchObject({ ok: false, nativeStatus: -5, outcome: "busy" });
    expect(answer.fileDetail).toBeUndefined();
  }));

  it("reports missing activation and unsupported history explicitly", () => withMemoryMcpFixture(async f => {
    activate(f);
    expect(await handleMemoryQueryEvent(event("MemoryReset"), config(false))).toMatchObject({ ok: false, errorCode: "MCP_NOT_CONFIGURED" });
    expect(await handleMemoryQueryEvent(event("MemoryHistory"), config())).toMatchObject({ ok: false, errorCode: "MEMORY_HISTORY_UNSUPPORTED" });
    expect(f.calls).toHaveLength(0);
    vi.stubEnv("CELIA_MEMORY_HTTP_URL", "");
    expect(await handleMemoryQueryEvent(event("MemoryReset"), config())).toMatchObject({ ok: false, errorCode: "MEMORY_CONFIGURATION_INVALID" });
    expect(f.calls).toHaveLength(0);
  }));
});

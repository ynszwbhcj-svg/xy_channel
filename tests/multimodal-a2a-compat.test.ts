import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(), dispatch: vi.fn(), download: vi.fn(), loadImages: vi.fn(),
}));
vi.mock("../src/transport/client.js", () => ({
  getXYWebSocketManager: () => ({ sendMessage: mocks.sendMessage }),
}));
vi.mock("../src/runtime.js", () => ({
  getXYRuntime: () => ({ channel: {
    routing: { resolveAgentRoute: ({ peer }: any) => ({ sessionKey: `agent:main:direct:${peer.id}`, accountId: "default" }) },
    reply: { dispatchReplyFromConfig: mocks.dispatch },
  } }),
}));
vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  resolveRuntimeConversationBindingRoute: ({ route }: any) => ({ route }),
}));
vi.mock("../src/config.js", () => ({
  resolveXYConfig: () => ({ agentId: "test-agent", pinnedSessionIds: [], terminalFrameDelayMs: 0 }),
}));
vi.mock("../src/file-download.js", () => ({ downloadFilesFromParts: mocks.download }));
vi.mock("../src/native-images.js", () => ({
  NATIVE_IMAGE_MAX_BYTES: 6 * 1024 * 1024,
  NativeImageInputError: class NativeImageInputError extends Error {},
  loadNativeImages: mocks.loadImages,
}));
vi.mock("../src/utils/runtime-manager.js", () => ({ saveRuntimeInfo: async () => {} }));
vi.mock("../src/utils/self-evolution-manager.js", () => ({ selfEvolutionManager: { isEnabled: async () => false } }));
vi.mock("../src/sensitive-redactor.js", () => ({ redactSensitiveText: (text: string) => text, containsSensitiveInfo: () => false }));
vi.mock("../src/utils/logger.js", () => {
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: { ...logger, withContext: () => logger }, isA2AOutLogEnabled: () => true };
});

// Deliberately use the real current formatter, legacy formatter, outbound
// gateway and per-session queue; only the WebSocket transport is intercepted.
import { handleXYMessage } from "../src/dispatch/bot.js";
import { bindSessionKey, deleteSession, getCurrentTaskId, getOrCreateSession, listSessions, registerTask } from "../src/conversation/conversation-manager.js";
import { releaseAppVersion } from "../src/utils/app-version.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendMessage.mockResolvedValue(undefined);
  mocks.download.mockResolvedValue([]); // force a missing native image
});
afterEach(() => {
  for (const session of listSessions()) deleteSession(session.sessionId);
});

describe("native image failures through upstream A2A formatters", () => {
  it.each([
    ["11.7.9.310", false], ["11.7.9.329", false], ["11.7.9.330", true],
  ])("preserves %s framing and the older active task", async (appVer, modern) => {
    const sessionId = `native-failure-${appVer}`;
    const taskId = `incoming-${appVer}`;
    registerTask(sessionId, "old-task", "old-message");
    bindSessionKey(`agent:main:direct:${sessionId}`, sessionId, "old-task", "old-message");
    getOrCreateSession(sessionId).state = "waiting-subagent";
    const admitted = vi.fn();
    const message = {
      jsonrpc: "2.0", method: "tasks/send", id: "new-message",
      params: { id: taskId, sessionId, message: { role: "user", parts: [
        { kind: "file", file: { name: "missing.png", mimeType: "image/png", uri: "https://image.invalid/missing.png" } },
        { kind: "data", data: { variables: {
          clientVariables: { modelName: "Vision", modelInput: ["text", "image"] },
          systemVariables: { device_type: "phone", app_ver: appVer },
        } } },
      ] } },
    } as any;

    await handleXYMessage({ cfg: {}, runtime: { error: vi.fn() }, accountId: "default", message, onTurnAdmitted: admitted });

    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(admitted).not.toHaveBeenCalled();
    expect(getCurrentTaskId(sessionId)).toBe("old-task");
    expect(getOrCreateSession(sessionId).state).toBe("waiting-subagent");
    const envelopes = mocks.sendMessage.mock.calls.map(([, envelope]) => envelope);
    expect(envelopes.length).toBeGreaterThanOrEqual(3);
    expect(envelopes.every((envelope) => envelope.taskId === taskId && envelope.sessionId === sessionId)).toBe(true);
    const results = envelopes.map((envelope) => JSON.parse(envelope.msgDetail).result);
    expect(results.filter((result) => result.final)).toHaveLength(1);
    expect(results.at(-1).final).toBe(true);
    expect(results.some((result) => result.kind === "status-update" && result.status?.state === "failed")).toBe(true);
    const cards = results.flatMap((result) => result.artifact?.parts ?? [])
      .flatMap((part: any) => part.data?.commands ?? [])
      .filter((command: any) => command.header?.name === "DisplayTaskCardData");
    if (modern) {
      expect(results.every((result) => result.isNew === true)).toBe(true);
      expect(cards.map((card: any) => card.payload.isFinal)).toEqual([false, true]);
      const ids = results.filter((result) => result.kind === "artifact-update").map((result) => result.streamingTextId);
      expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(1); // latest command/id alignment survives the new error path
    } else {
      expect(results.some((result) => result.isNew === true)).toBe(false);
      expect(cards).toHaveLength(0);
    }
    releaseAppVersion(taskId);
  });
});

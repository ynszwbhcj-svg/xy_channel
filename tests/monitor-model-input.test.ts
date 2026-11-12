import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ws: null as any,
  active: new Set<string>(),
  handle: vi.fn(),
}));
vi.mock("../src/transport/client.js", () => ({
  getXYWebSocketManager: () => mocks.ws,
  diagnoseAllManagers: vi.fn(), cleanupOrphanConnections: vi.fn(), removeXYWebSocketManager: vi.fn(),
}));
vi.mock("../src/config.js", () => ({ resolveXYConfig: () => ({ enabled: true }) }));
vi.mock("../src/dispatch/bot.js", () => ({ handleXYMessage: mocks.handle }));
vi.mock("../src/conversation/conversation-manager.js", () => ({
  hasActiveTask: (sessionId: string) => mocks.active.has(sessionId), listActiveTaskBindings: () => [],
}));
vi.mock("../src/formatter.js", () => ({ sendA2AResponse: vi.fn() }));
vi.mock("../src/trigger-handler.js", () => ({ handleTriggerEvent: vi.fn() }));
vi.mock("../src/self-evolution-handler.js", () => ({ handleSelfEvolutionEvent: vi.fn(), handleSelfEvolutionStateGetEvent: vi.fn() }));
vi.mock("../src/login-token-handler.js", () => ({ handleLoginTokenEvent: vi.fn() }));
vi.mock("../src/cron-query-handler.js", () => ({ handleCronQueryEvent: vi.fn() }));
vi.mock("../src/memory-query-handler.js", () => ({ handleMemoryQueryEvent: vi.fn() }));
vi.mock("../src/update-task-conv-id-handler.js", () => ({ handleUpdateTaskConvIdEvent: vi.fn() }));
vi.mock("../src/dispatch/reply-dispatcher.js", () => ({ cleanupStaleTempFiles: vi.fn() }));
vi.mock("../src/utils/logger.js", () => ({ logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { monitorXYProvider } from "../src/dispatch/monitor.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function drain() { for (let i = 0; i < 25; i++) await Promise.resolve(); }
function message(id: string, input: unknown = ["text", "image"], options: { session?: string; image?: boolean; model?: string } = {}) {
  const sessionId = options.session ?? "a";
  return {
    jsonrpc: "2.0", method: "tasks/send", id,
    params: { sessionId, id: `task-${id}`, message: { parts: [
      { kind: "text", text: id },
      { kind: "data", data: { variables: { clientVariables: { modelName: options.model ?? "Vision", modelInput: input } } } },
      ...(options.image ? [{ kind: "file", file: { name: "picture.png", mimeType: "image/png", uri: "https://image.invalid/picture.png" } }] : []),
    ] } },
  };
}

describe("monitor multimodal admission", () => {
  let controller: AbortController;
  let running: Promise<void>;
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const keepActive = new Set<string>();
  const rejected = new Set<string>();

  beforeEach(() => {
    mocks.active.clear();
    gates.clear();
    keepActive.clear();
    rejected.clear();
    mocks.ws = Object.assign(new EventEmitter(), {
      connect: vi.fn(async () => {}), disconnect: vi.fn(), setHealthEventCallback: vi.fn(),
    });
    mocks.handle.mockReset();
    mocks.handle.mockImplementation(async ({ message: msg, forceNewTurn, onTurnAdmitted }) => {
      if (msg.method === "tasks/send") {
        if (rejected.has(msg.id)) return; // e.g. image failed validation before dispatch
        if (!mocks.active.has(msg.params.sessionId) || forceNewTurn) onTurnAdmitted?.();
        mocks.active.add(msg.params.sessionId);
        const gate = gates.get(msg.id);
        if (gate) {
          await gate.promise;
          if (!keepActive.has(msg.id)) mocks.active.delete(msg.params.sessionId);
        }
      }
    });
    controller = new AbortController();
    running = monitorXYProvider({ config: { messages: { queue: { mode: "steer" } } }, abortSignal: controller.signal });
  });
  afterEach(async () => {
    for (const gate of gates.values()) gate.resolve();
    await drain();
    controller.abort();
    await running;
  });
  function emit(msg: ReturnType<typeof message> | any) {
    mocks.ws.emit("message", msg, msg.params?.sessionId ?? msg.sessionId, "test-server");
  }
  function ids() { return mocks.handle.mock.calls.map(([params]) => params.message.id); }

  it("preserves same-model text steer but queues images and subsequent text in order", async () => {
    gates.set("first", deferred());
    gates.set("image", deferred());
    emit(message("first"));
    await drain();
    emit(message("steer"));
    await drain();
    expect(ids()).toEqual(["first", "steer"]);
    expect(mocks.handle.mock.calls[1][0].forceNewTurn).toBe(false);

    emit(message("image", ["text", "image"], { image: true }));
    emit(message("after-image"));
    emit(message("other-session", ["text"], { session: "b" }));
    await drain();
    expect(ids()).toEqual(["first", "steer", "other-session"]);
    gates.get("first")!.resolve();
    await drain();
    expect(ids()).toEqual(["first", "steer", "other-session", "image"]);
    expect(mocks.handle.mock.calls[3][0].forceNewTurn).toBe(true);
    gates.get("image")!.resolve();
    await drain();
    expect(ids()).toEqual(["first", "steer", "other-session", "image", "after-image"]);
    expect(mocks.handle.mock.calls[4][0].forceNewTurn).toBe(true);
  });

  it.each([
    [["text"], "Vision"],
    [undefined, "Vision"],
    [["text", "image"], "DifferentModel"],
  ])("isolates model/capability switch %j/%s from the active run", async (input, selectedModel) => {
    gates.set("first", deferred());
    emit(message("first"));
    await drain();
    const changed = message("changed", input, { model: selectedModel });
    if (input === undefined) delete changed.params.message.parts[1].data.variables.clientVariables.modelInput;
    emit(changed);
    await drain();
    expect(ids()).toEqual(["first"]);
    gates.get("first")!.resolve();
    await drain();
    expect(ids()).toEqual(["first", "changed"]);
    expect(mocks.handle.mock.calls[1][0].forceNewTurn).toBe(true);
  });

  it("does not let a later text message pass a queued reset; cancel stays immediate", async () => {
    gates.set("first", deferred());
    emit(message("first"));
    await drain();
    emit({ method: "clearContext", id: "reset", sessionId: "a" });
    emit(message("after-reset"));
    emit({ method: "tasks/cancel", id: "cancel", sessionId: "a" });
    await drain();
    expect(ids()).toEqual(["first", "cancel"]);
    gates.get("first")!.resolve();
    await drain();
    expect(ids()).toEqual(["first", "cancel", "reset", "after-reset"]);
  });

  it("does not publish rejected image capabilities over an existing waiting task", async () => {
    gates.set("first", deferred());
    keepActive.add("first");
    rejected.add("bad-image");
    emit(message("first", ["text"]));
    await drain();
    emit(message("bad-image", ["text", "image"], { image: true }));
    gates.get("first")!.resolve();
    await drain();
    emit(message("native-text"));
    await drain();
    expect(ids()).toEqual(["first", "bad-image", "native-text"]);
    expect(mocks.handle.mock.calls[2][0].forceNewTurn).toBe(true);
  });

  it("keeps A2A conversations separate when they share a transport session", async () => {
    gates.set("a-first", deferred());
    gates.set("b-first", deferred());
    mocks.ws.emit("message", message("a-first", ["text"], { session: "a", model: "Text" }), "shared-socket", "server");
    mocks.ws.emit("message", message("b-first", ["text", "image"], { session: "b" }), "shared-socket", "server");
    await drain();
    expect(ids()).toEqual(["a-first", "b-first"]);
    mocks.ws.emit("message", message("a-steer", ["text"], { session: "a", model: "Text" }), "shared-socket", "server");
    mocks.ws.emit("message", message("b-steer", ["text", "image"], { session: "b" }), "shared-socket", "server");
    await drain();
    expect(ids()).toEqual(["a-first", "b-first", "a-steer", "b-steer"]);
    for (const [params] of mocks.handle.mock.calls) {
      expect(params.webSocketSessionId).toBe("shared-socket");
      expect(params.forceNewTurn).toBe(false);
    }
  });

  it("does not start queued image turns after the monitor is stopped", async () => {
    gates.set("first", deferred());
    emit(message("first"));
    await drain();
    emit(message("image", ["text", "image"], { image: true }));
    controller.abort();
    await running;
    gates.get("first")!.resolve();
    await drain();
    expect(ids()).toEqual(["first"]);
  });
});

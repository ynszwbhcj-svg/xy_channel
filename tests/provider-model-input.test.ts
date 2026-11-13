import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/logger.js", () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/utils/self-evolution-manager.js", () => ({
  selfEvolutionManager: { isEnabled: vi.fn().mockResolvedValue(false) },
}));
vi.mock("../src/formatter.js", () => ({ sendStatusUpdate: vi.fn().mockResolvedValue(undefined) }));

import { xiaoyiProvider } from "../src/provider.js";
import { resolveModelInput } from "../src/model-input.js";
import { runWithSessionContext } from "../src/tools/session-manager.js";

const model = {
  id: "SelectedModel",
  name: "Configured model",
  provider: "xiaoyiprovider",
  api: "openai-completions",
  baseUrl: "https://model.invalid/v1",
  input: ["text"],
  reasoning: false,
  contextWindow: 128_000,
  maxTokens: 8_192,
  headers: { "x-configured": "preserved" },
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
};

function session(raw: unknown, modelName = model.id, sessionId = "model-input-test"): any {
  return {
    config: {},
    sessionId,
    taskId: `${sessionId}&turn`,
    messageId: "message-input-test",
    agentId: "default",
    modelName,
    modelCapabilities: resolveModelInput(raw),
  };
}

function normalize(candidate = model, provider = "xiaoyiprovider"): any {
  return xiaoyiProvider.normalizeResolvedModel!({
    provider,
    modelId: candidate.id,
    model: candidate,
  } as any);
}

async function* doneStream() {
  yield { type: "text_delta", delta: "ok" };
  yield { type: "done", message: { stopReason: "stop", content: [{ type: "text", text: "ok" }] } };
}

async function* errorStream() {
  yield {
    type: "error",
    error: { stopReason: "error", errorMessage: "content_filter" },
  };
}

async function collect(stream: any): Promise<any[]> {
  const events = [];
  for await (const event of stream) events.push(event);
  await stream.result();
  return events;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("provider request modelInput", () => {
  it("enables images for an explicitly configured/static model without mutating the catalog", async () => {
    const resolved = await runWithSessionContext(session(["text", "image"]), async () => normalize());
    expect(resolved.input).toEqual(["text", "image"]);
    expect(resolved).not.toBe(model);
    expect(model.input).toEqual(["text"]);
    expect(resolved).toEqual({ ...model, input: ["text", "image"] });
    expect(resolved.headers).toBe(model.headers);
    expect(resolved.cost).toBe(model.cost);
  });

  it.each([undefined, ["text"], [], null, "[\"text\",\"image\"]", ["image", 1]])(
    "keeps a legacy/invalid declaration text-only even when the catalog advertises images (%j)",
    async (raw) => {
      const configured = { ...model, input: ["text", "image"] };
      const resolved = await runWithSessionContext(session(raw), async () => normalize(configured));
      expect(resolved.input).toEqual(["text"]);
      expect(configured.input).toEqual(["text", "image"]);
    },
  );

  it("does not rewrite models outside a channel capability scope or a different selected model", async () => {
    expect(normalize()).toBe(model);
    await runWithSessionContext(session(["text", "image"]), async () => {
      expect(normalize({ ...model, id: "CompactionModel" }).input).toEqual(["text"]);
      expect(normalize(model, "another-provider")).toBeUndefined();
    });
  });

  it("supports provider-qualified selected names and omitted modelName", async () => {
    await runWithSessionContext(session(["image"], "xiaoyiprovider/SelectedModel"), async () => {
      expect(normalize().input).toEqual(["text", "image"]);
    });
    const withoutName = session(["image"]);
    delete withoutName.modelName;
    await runWithSessionContext(withoutName, async () => {
      expect(normalize().input).toEqual(["text", "image"]);
    });
  });

  it("keeps concurrent ALS request capabilities isolated", async () => {
    const [imageModel, textModel] = await Promise.all([
      runWithSessionContext(session(["image"], model.id, "image-session"), async () => {
        await Promise.resolve();
        return normalize();
      }),
      runWithSessionContext(session(undefined, model.id, "legacy-session"), async () => {
        await Promise.resolve();
        return normalize();
      }),
    ]);
    expect(imageModel.input).toEqual(["text", "image"]);
    expect(textModel.input).toEqual(["text"]);
    expect(normalize()).toBe(model);
  });

  it("applies the same early capability declaration to dynamically resolved models", async () => {
    const resolve = () => xiaoyiProvider.resolveDynamicModel!({
      provider: "xiaoyiprovider",
      modelId: model.id,
      providerConfig: { baseUrl: model.baseUrl, headers: model.headers },
    } as any);
    await runWithSessionContext(session(["image"]), async () => {
      const resolved = resolve();
      expect(resolved.input).toEqual(["text", "image"]);
      expect(resolved.baseUrl).toBe(model.baseUrl);
      expect(resolved.headers["x-configured"]).toBe("preserved");
      expect(resolved.contextWindow).toBe(256_000);
      expect(resolved.maxTokens).toBe(64_000);
    });
    await runWithSessionContext(session(undefined), async () => {
      expect(resolve().input).toEqual(["text"]);
    });
  });

  it("keeps outgoing model capability consistent without adding or duplicating image content", async () => {
    const image = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
    const context = { messages: [{ role: "user", content: [{ type: "text", text: "看图" }, image] }] };
    const underlying = vi.fn(() => doneStream());
    const wrapped = xiaoyiProvider.wrapStreamFn!({ streamFn: underlying } as any)!;
    await runWithSessionContext(session(["image"]), async () => {
      await collect(await wrapped(model as any, context as any, { headers: { "x-existing": "kept" } }));
      await collect(await wrapped(model as any, context as any, {}));
    });
    expect(underlying).toHaveBeenCalledTimes(2);
    for (const [actualModel, actualContext] of underlying.mock.calls as any) {
      expect(actualModel.input).toEqual(["text", "image"]);
      expect(actualModel.maxTokens).toBe(model.maxTokens);
      expect(actualContext.messages[0].content).toEqual([{ type: "text", text: "看图" }, image]);
    }
    expect((underlying.mock.calls as any)[0][2].headers["x-existing"]).toBe("kept");
    expect(model.input).toEqual(["text"]);
  });

  it("normalizes the selected model name before enforcing the outgoing input policy", async () => {
    const underlying = vi.fn(() => doneStream());
    const wrapped = xiaoyiProvider.wrapStreamFn!({ streamFn: underlying } as any)!;
    await runWithSessionContext(session(["image"], " xiaoyiprovider/SelectedModel "), async () => {
      await collect(await wrapped({ ...model, id: "OldModel" } as any, {
        messages: [{ role: "user", content: "new selection" }],
      } as any, {}));
    });
    expect((underlying.mock.calls as any)[0][0]).toMatchObject({ id: "SelectedModel", input: ["text", "image"] });
  });

  it("forces the outgoing serializer to text-only when this request omits modelInput", async () => {
    const underlying = vi.fn(() => doneStream());
    const wrapped = xiaoyiProvider.wrapStreamFn!({ streamFn: underlying } as any)!;
    await runWithSessionContext(session(undefined), async () => {
      await collect(await wrapped({ ...model, input: ["text", "image"] } as any, {
        messages: [{ role: "user", content: "legacy client" }],
      } as any, {}));
    });
    expect((underlying.mock.calls as any)[0][0].input).toEqual(["text"]);
  });
});

describe("Kimi fallback image safety", () => {
  it.each(["user", "toolResult"])("never sends %s images to the unverified fallback model", async (role) => {
    vi.useFakeTimers();
    const context = {
      messages: [{ role, content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] }],
    };
    const underlying = vi.fn(() => errorStream());
    const wrapped = xiaoyiProvider.wrapStreamFn!({ streamFn: underlying } as any)!;
    const pending = runWithSessionContext(session(["image"], "Kimi_K3"), async () =>
      collect(await wrapped({ ...model, id: "Kimi_K3" } as any, context as any, {})),
    );
    await vi.runAllTimersAsync();
    const events = await pending;
    expect(underlying).toHaveBeenCalledTimes(5);
    expect((underlying.mock.calls as any).every(([candidate]) => candidate.id === "Kimi_K3")).toBe(true);
    expect(events.at(-1).type).toBe("error");
  });

  it("preserves text-only fallback and does not inherit the primary model's image capability", async () => {
    vi.useFakeTimers();
    const underlying = vi.fn((candidate) => candidate.id === "MiniMax-M3" ? doneStream() : errorStream());
    const wrapped = xiaoyiProvider.wrapStreamFn!({ streamFn: underlying } as any)!;
    const pending = runWithSessionContext(session(["image"], "Kimi_K3"), async () =>
      collect(await wrapped({ ...model, id: "Kimi_K3" } as any, {
        messages: [{ role: "user", content: "纯文字消息" }],
      } as any, {})),
    );
    await vi.runAllTimersAsync();
    const events = await pending;
    expect(underlying).toHaveBeenCalledTimes(6);
    expect(underlying.mock.calls[5][0]).toMatchObject({ id: "MiniMax-M3", input: ["text"] });
    expect(events.at(-1).type).toBe("done");
  });

  it("preserves fallback for legacy Channel text turns even with old image history", async () => {
    vi.useFakeTimers();
    const underlying = vi.fn((candidate) => candidate.id === "MiniMax-M3" ? doneStream() : errorStream());
    const wrapped = xiaoyiProvider.wrapStreamFn!({ streamFn: underlying } as any)!;
    const pending = runWithSessionContext(session(undefined, "Kimi_K3", "legacy-fallback"), async () =>
      collect(await wrapped({ ...model, id: "Kimi_K3" } as any, {
        messages: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "old-image" }] }],
      } as any, {})),
    );
    await vi.runAllTimersAsync();
    const events = await pending;
    expect(underlying).toHaveBeenCalledTimes(6);
    expect(underlying.mock.calls[5][0]).toMatchObject({ id: "MiniMax-M3", input: ["text"] });
    expect(events.at(-1).type).toBe("done");
  });

  it("does not change fallback policy or metadata for calls outside Channel capability scope", async () => {
    vi.useFakeTimers();
    const underlying = vi.fn((candidate) => candidate.id === "MiniMax-M3" ? doneStream() : errorStream());
    const wrapped = xiaoyiProvider.wrapStreamFn!({ streamFn: underlying } as any)!;
    const pending = collect(await wrapped({ ...model, id: "Kimi_K3", input: ["text", "image"] } as any, {
      messages: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "other-consumer-image" }] }],
    } as any, {}));
    await vi.runAllTimersAsync();
    const events = await pending;
    expect(underlying).toHaveBeenCalledTimes(6);
    expect(underlying.mock.calls[5][0]).toMatchObject({ id: "MiniMax-M3", input: ["text", "image"] });
    expect(events.at(-1).type).toBe("done");
  });
});

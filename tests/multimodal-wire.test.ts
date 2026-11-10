import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import { encodePngRgba } from "openclaw/plugin-sdk/media-runtime";
import { xiaoyiProvider } from "../src/provider.js";
import { extractModelInput, extractModelName } from "../src/parser.js";
import { loadNativeImages } from "../src/native-images.js";
import { runWithSessionContext } from "../src/tools/session-manager.js";

vi.mock("../src/utils/logger.js", () => ({
  logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("../src/utils/self-evolution-manager.js", () => ({
  selfEvolutionManager: { isEnabled: async () => false },
}));
vi.mock("../src/formatter.js", () => ({ sendStatusUpdate: vi.fn() }));

const PNG_BUFFER = encodePngRgba(Buffer.from([255, 0, 0, 255]), 1, 1);
const PNG = PNG_BUFFER.toString("base64");
const fixtureDirectories: string[] = [];
const model = {
  id: "Integration_Vision", name: "Integration_Vision", api: "openai-completions",
  provider: "xiaoyiprovider", baseUrl: "https://model.integration.invalid/v1",
  reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000, maxTokens: 4096,
};

function successStream(): Response {
  const frames = [
    { id: "test", object: "chat.completion.chunk", created: 1, model: model.id,
      choices: [{ index: 0, delta: { role: "assistant", content: "图片已收到" }, finish_reason: null }] },
    { id: "test", object: "chat.completion.chunk", created: 1, model: model.id,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(fixtureDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("real OpenClaw OpenAI-compatible HTTP serialization", () => {
  it.each([
    [["text", "image"], true],
    [["text"], false],
    [undefined, false],
  ])("applies modelInput %j to actual image_url payload", async (rawInput, native) => {
    const requests: Array<{ body: any; headers: Headers }> = [];
    // Intercept the transport only; model normalization, provider wrapping,
    // SDK serialization and SSE response parsing all use the real code.
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requests.push({ body: JSON.parse(init.body), headers: new Headers(init.headers) });
      return successStream();
    }));

    const parts = [{ kind: "data", data: { variables: { clientVariables: {
      modelName: model.id, modelInput: rawInput,
    } } } }] as any;
    const capabilities = extractModelInput(parts);
    let image = { type: "image", data: PNG, mimeType: "image/png" };
    if (native) {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xy-wire-"));
      fixtureDirectories.push(directory);
      const imagePath = path.join(directory, "red-pixel.png");
      await fs.writeFile(imagePath, PNG_BUFFER);
      [image] = await loadNativeImages([{ path: imagePath, name: "red-pixel.png" }], {});
    }

    await runWithSessionContext({
      config: {} as any, sessionId: "wire-session", taskId: "wire-session&interaction",
      messageId: "wire-message", agentId: "default", modelName: extractModelName(parts),
      modelCapabilities: capabilities,
    }, async () => {
      const resolved = xiaoyiProvider.normalizeResolvedModel!({ provider: model.provider, modelId: model.id, model } as any)!;
      const wrapped = xiaoyiProvider.wrapStreamFn!({ streamFn: streamSimple } as any)!;
      const stream = await wrapped(resolved as any, {
        messages: [{ role: "user", timestamp: 1, content: [
          { type: "text", text: "请描述图片" },
          image,
        ] }],
      } as any, { apiKey: "integration-test-key" });
      for await (const _event of stream as any) { /* consume the real SDK response */ }
      expect((await (stream as any).result()).stopReason).toBe("stop");
    });

    expect(requests).toHaveLength(1);
    const content = requests[0].body.messages.find((message: any) => message.role === "user").content;
    const imageParts = Array.isArray(content) ? content.filter((part: any) => part.type === "image_url") : [];
    expect(imageParts).toHaveLength(native ? 1 : 0);
    if (native) expect(imageParts[0].image_url.url).toBe(`data:image/png;base64,${PNG}`);
    else expect(JSON.stringify(requests[0].body)).not.toContain(PNG);
    expect(JSON.stringify(content)).toContain("请描述图片");
    expect(requests[0].body.model).toBe(model.id);
    expect(requests[0].headers.get("x-hag-trace-id")).toBe("wire-session&interaction");
    expect(model.input).toEqual(["text"]); // no mutation of shared catalog entries
  });
});

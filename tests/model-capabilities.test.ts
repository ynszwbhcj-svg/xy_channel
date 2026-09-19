import { describe, expect, it } from "vitest";
import {
  isImageAttachment,
  resolveModelCapabilities,
  withImagePreservingFollowupQueue,
} from "../src/model-capabilities.js";

describe("resolveModelCapabilities", () => {
  it("enables native images for the built-in Kimi_K3 model", () => {
    expect(resolveModelCapabilities({ modelId: "Kimi_K3" })).toEqual({
      input: ["text", "image"],
      supportsNativeImages: true,
      source: "channel-default",
    });
  });

  it("matches the configured model ID case-insensitively", () => {
    expect(resolveModelCapabilities({ modelId: "kimi_k3" }).supportsNativeImages).toBe(true);
  });

  it("keeps DeepSeek and unknown dynamic models text-only", () => {
    expect(resolveModelCapabilities({ modelId: "LLM_DeepSeekV4_Flash" }).input).toEqual(["text"]);
    expect(resolveModelCapabilities({ modelId: "MiniMax-M3" }).input).toEqual(["text"]);
    expect(resolveModelCapabilities({ modelId: "future-unknown-model" }).input).toEqual(["text"]);
  });

  it("allows future multimodal models through channel configuration", () => {
    const result = resolveModelCapabilities({
      modelId: "future-vision-model",
      nativeImageModels: ["Future-Vision-Model"],
    });

    expect(result).toEqual({
      input: ["text", "image"],
      supportsNativeImages: true,
      source: "channel-config",
    });
  });

  it("lets an explicit provider model input declaration take priority", () => {
    const config = {
      models: {
        providers: {
          xiaoyiprovider: {
            models: [
              { id: "custom-vision", input: ["text", "image"] },
              { id: "Kimi_K3", input: ["text"] },
            ],
          },
        },
      },
    };

    expect(resolveModelCapabilities({ modelId: "custom-vision", config })).toMatchObject({
      input: ["text", "image"],
      supportsNativeImages: true,
      source: "provider-model",
    });
    expect(resolveModelCapabilities({ modelId: "Kimi_K3", config })).toMatchObject({
      input: ["text"],
      supportsNativeImages: false,
      source: "provider-model",
    });
  });

  it("allows an explicit empty channel list to disable the Kimi default", () => {
    const config = {
      channels: {
        "xiaoyi-channel": { nativeImageModels: [] },
      },
    };

    expect(resolveModelCapabilities({ modelId: "Kimi_K3", config }).supportsNativeImages).toBe(false);
  });
});

describe("multimodal attachment routing", () => {
  it("detects images from MIME type or common filename extensions", () => {
    expect(isImageAttachment({ name: "upload.bin", mimeType: "image/png" })).toBe(true);
    expect(isImageAttachment({ name: "photo.HEIC", mimeType: "application/octet-stream" })).toBe(true);
    expect(isImageAttachment({ name: "notes.pdf", mimeType: "application/pdf" })).toBe(false);
  });

  it("clones config and forces followup mode without mutating the original", () => {
    const config = {
      messages: {
        queue: { mode: "steer", debounceMs: 250 },
      },
    };

    const result = withImagePreservingFollowupQueue(config);

    expect(result).not.toBe(config);
    expect(result.messages.queue).toEqual({ mode: "followup", debounceMs: 250 });
    expect(config.messages.queue.mode).toBe("steer");
  });
});

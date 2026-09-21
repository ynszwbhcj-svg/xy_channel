import { describe, expect, it } from "vitest";
import {
  filterToolsForModelCapabilities,
  isImageAttachment,
  resolveConfiguredDefaultModelName,
  resolveEffectiveModelName,
  resolveModelCapabilities,
  resolveSessionEntryModelName,
  shouldPreserveImageForQueuedTurn,
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

  it("preserves an active Kimi image turn after session-model fallback", () => {
    const effective = resolveEffectiveModelName({
      explicitModelName: "",
      sessionModelName: "Kimi_K3",
    });
    const capabilities = resolveModelCapabilities({ modelId: effective.modelName! });

    expect(shouldPreserveImageForQueuedTurn({
      isUpdate: true,
      hasImageAttachment: true,
      capabilities,
    })).toBe(true);
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

describe("resolveEffectiveModelName", () => {
  it("prefers an explicit model over the persisted session model", () => {
    expect(resolveEffectiveModelName({
      explicitModelName: " Kimi_K3 ",
      sessionModelName: "LLM_DeepSeekV4_Flash",
    })).toEqual({ modelName: "Kimi_K3", source: "explicit" });
  });

  it("falls back to the Kimi session model for an empty image-turn model", () => {
    const sessionModel = resolveSessionEntryModelName({
      providerOverride: "xiaoyiprovider",
      modelOverride: "Kimi_K3",
    });
    const effective = resolveEffectiveModelName({
      explicitModelName: "   ",
      sessionModelName: sessionModel,
    });

    expect(effective).toEqual({ modelName: "Kimi_K3", source: "session" });
    expect(resolveModelCapabilities({ modelId: effective.modelName! }).supportsNativeImages).toBe(true);
  });

  it("falls back to configured MiniMax and DeepSeek session models", () => {
    const minimax = resolveEffectiveModelName({
      explicitModelName: "",
      sessionModelName: "MiniMax-M3",
    });
    const deepseek = resolveEffectiveModelName({
      explicitModelName: undefined,
      sessionModelName: "xiaoyiprovider/LLM_DeepSeekV4_Flash",
    });

    expect(minimax).toEqual({ modelName: "MiniMax-M3", source: "session" });
    expect(resolveModelCapabilities({
      modelId: minimax.modelName!,
      nativeImageModels: ["Kimi_K3", "MiniMax-M3"],
    }).supportsNativeImages).toBe(true);
    expect(deepseek).toEqual({ modelName: "LLM_DeepSeekV4_Flash", source: "session" });
    expect(resolveModelCapabilities({ modelId: deepseek.modelName! }).supportsNativeImages).toBe(false);
  });

  it("uses the configured default only when explicit and session models are absent", () => {
    const config = { agents: { defaults: { model: { primary: "xiaoyiprovider/Kimi_K3" } } } };
    expect(resolveConfiguredDefaultModelName(config)).toBe("Kimi_K3");
    expect(resolveEffectiveModelName({
      explicitModelName: "none",
      sessionModelName: null,
      defaultModelName: resolveConfiguredDefaultModelName(config),
    })).toEqual({ modelName: "Kimi_K3", source: "default" });
    expect(resolveConfiguredDefaultModelName({
      agents: { defaults: { model: "other-provider/vision-model" } },
    })).toBeUndefined();
  });

  it("returns unknown when no explicit, session, or Xiaoyi default model is available", () => {
    expect(resolveEffectiveModelName({
      explicitModelName: "",
      sessionModelName: undefined,
      defaultModelName: undefined,
    })).toEqual({ source: "unknown" });
  });

  it("tracks explicit model switches and lets the next blank turn inherit the latest value", () => {
    let sessionModel = "LLM_DeepSeekV4_Flash";
    for (const explicit of ["Kimi_K3", "LLM_DeepSeekV4_Flash", "Kimi_K3"]) {
      const switched = resolveEffectiveModelName({ explicitModelName: explicit, sessionModelName: sessionModel });
      sessionModel = switched.modelName!;
      expect(resolveEffectiveModelName({ explicitModelName: "", sessionModelName: sessionModel }))
        .toEqual({ modelName: explicit, source: "session" });
    }
  });
});

describe("model-aware image_reading exposure", () => {
  const tools = [{ name: "image_reading" }, { name: "other_tool" }];

  it("hides image_reading for native-image models", () => {
    const capabilities = resolveModelCapabilities({ modelId: "Kimi_K3" });
    expect(filterToolsForModelCapabilities(tools, capabilities).map((tool) => tool.name))
      .toEqual(["other_tool"]);
  });

  it("keeps image_reading for text-only and unknown models", () => {
    const textOnly = resolveModelCapabilities({ modelId: "LLM_DeepSeekV4_Flash" });
    expect(filterToolsForModelCapabilities(tools, textOnly).map((tool) => tool.name))
      .toEqual(["image_reading", "other_tool"]);
    expect(filterToolsForModelCapabilities(tools, undefined).map((tool) => tool.name))
      .toEqual(["image_reading", "other_tool"]);
  });

  it("keeps text-only and unknown image steer on the legacy fallback path", () => {
    const textOnly = resolveModelCapabilities({ modelId: "LLM_DeepSeekV4_Flash" });
    expect(shouldPreserveImageForQueuedTurn({
      isUpdate: true,
      hasImageAttachment: true,
      capabilities: textOnly,
    })).toBe(false);
    expect(shouldPreserveImageForQueuedTurn({
      isUpdate: true,
      hasImageAttachment: true,
      capabilities: undefined,
    })).toBe(false);
  });
});

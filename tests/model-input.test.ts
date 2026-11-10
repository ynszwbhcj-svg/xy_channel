import { describe, expect, it } from "vitest";
import { inheritSelectedModelName, isImageAttachment, modelSelectionChanged, resolveModelInput } from "../src/model-input.js";

describe("request modelInput policy", () => {
  it.each([
    [["text", "image"], true, "request"],
    [["image"], true, "request"],
    [["text", "image", "audio", "image"], true, "request"],
    [["text"], false, "request"],
    [[], false, "request"],
    [["IMAGE"], false, "request"],
    [[" image "], false, "request"],
    [undefined, false, "missing"],
    [null, false, "invalid"],
    ['["text","image"]', false, "invalid"],
    [{ image: true }, false, "invalid"],
    [["image", 1], false, "invalid"],
  ])("resolves %j without guessing model capabilities", (raw, supports, source) => {
    const result = resolveModelInput(raw);
    expect(result).toEqual({
      input: supports ? ["text", "image"] : ["text"],
      supportsNativeImages: supports,
      source,
    });
  });

  it("does not share mutable policy arrays between requests", () => {
    resolveModelInput(["image"]).input.splice(0);
    expect(resolveModelInput(["image"]).input).toEqual(["text", "image"]);
  });

  it("retains only the selected model name, never the previous input", () => {
    const previous = { modelName: "Kimi_K3", modelCapabilities: resolveModelInput(["image"]) };
    const next = { modelCapabilities: resolveModelInput(undefined) };
    expect(modelSelectionChanged(previous, next)).toBe(true);
    expect(inheritSelectedModelName(previous, next)).toEqual({
      modelName: "Kimi_K3", modelCapabilities: resolveModelInput(undefined),
    });
  });

  it("only permits live steer when model and image capability agree", () => {
    const active = { modelName: "Kimi_K3", modelCapabilities: resolveModelInput(["text", "image"]) };
    expect(modelSelectionChanged(active, { ...active, modelName: undefined })).toBe(false);
    expect(modelSelectionChanged(active, { ...active, modelName: "xiaoyiprovider/Kimi_K3" })).toBe(false);
    expect(modelSelectionChanged(active, { ...active, modelName: "MiniMax-M3" })).toBe(true);
    expect(modelSelectionChanged(undefined, active)).toBe(true);
    expect(modelSelectionChanged(undefined, { modelCapabilities: resolveModelInput(undefined) })).toBe(false);
  });

  it.each([
    [{ name: "test", mimeType: "image/png" }, true],
    [{ name: "image.JPG" }, true],
    [{ name: "image.heic", mimeType: "application/octet-stream" }, true],
    [{ name: "not-an-image.jpg", mimeType: "application/pdf" }, false],
    [{ name: "document.pdf" }, false],
    [{ path: "/tmp/picture.webp" }, true],
  ])("classifies attachments %j", (file, expected) => {
    expect(isImageAttachment(file)).toBe(expected);
  });
});

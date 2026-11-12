import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectAndLoadAgentHarnessPromptImages } from "openclaw/plugin-sdk/agent-harness-runtime";
import * as mediaRuntime from "openclaw/plugin-sdk/media-runtime";
import { loadNativeImages, NATIVE_IMAGE_MAX_BYTES, NativeImageInputError } from "../src/native-images.js";

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>("openclaw/plugin-sdk/media-runtime");
  return { ...actual, resizeToPng: vi.fn(actual.resizeToPng) };
});

// Generate a complete valid PNG, including pixel data and chunk checksums.
// Decoding delegates to the real runtime except in the availability test.
const PNG = mediaRuntime.encodePngRgba(Buffer.from([255, 0, 0, 255]), 1, 1);
const directories: string[] = [];

async function fixture(name = "photo.png", content = PNG) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xy-native-images-"));
  directories.push(directory);
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, content);
  return { path: filePath, name };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("native image preparation using the installed OpenClaw runtime", () => {
  it("loads real image bytes even when an attachment has no image extension", async () => {
    const file = await fixture("attachment");
    const images = await loadNativeImages([file], {});

    expect(images).toEqual([{ type: "image", mimeType: "image/png", data: PNG.toString("base64") }]);
  });

  it("does not duplicate inline images when Media* produces the standard attachment notes", async () => {
    const first = await fixture("first.png");
    const second = await fixture("second.png");
    const images = await loadNativeImages([first, second], {});
    const prompt = `[media attached: 2 files]\n[media attached 1/2: ${first.path} (image/png) | https://example.test/first]\n[media attached 2/2: ${second.path} (image/png) | https://example.test/second]\n比较这两张图`;

    const result = await detectAndLoadAgentHarnessPromptImages({
      prompt,
      workspaceDir: path.dirname(first.path),
      model: { input: ["text", "image"] },
      existingImages: images,
      imageOrder: ["inline", "inline"],
      config: {},
    });

    expect(result.images).toHaveLength(2);
    expect(result.loadedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
  });

  it("rejects an image filename whose actual content is text", async () => {
    const file = await fixture("fake.png", Buffer.from("This is not a picture"));
    await expect(loadNativeImages([file], {})).rejects.toThrow(NativeImageInputError);
  });

  it("rejects empty and oversized attachments instead of silently dropping them", async () => {
    const empty = await fixture("empty.png", Buffer.alloc(0));
    await expect(loadNativeImages([empty], {})).rejects.toThrow("为空或超过大小限制");

    const oversized = await fixture("large.png");
    await fs.truncate(oversized.path, NATIVE_IMAGE_MAX_BYTES + 1);
    await expect(loadNativeImages([oversized], {})).rejects.toThrow("为空或超过大小限制");
  });

  it("rejects image data with an incomplete signature", async () => {
    const file = await fixture("broken.png", PNG.subarray(0, 8));
    await expect(loadNativeImages([file], {})).rejects.toThrow();
  });

  it.each([24, 33, 44])("rejects truncated PNG data with a readable header (%i bytes)", async (bytes) => {
    const file = await fixture("header-only.png", PNG.subarray(0, bytes));
    const result = loadNativeImages([file], {});
    await expect(result).rejects.toThrow(NativeImageInputError);
    await expect(result).rejects.toThrow("无法解码");
  });

  it("reports a missing image processor instead of accepting an unvalidated picture", async () => {
    const file = await fixture();
    vi.mocked(mediaRuntime.resizeToPng).mockRejectedValueOnce(
      new mediaRuntime.ImageProcessorUnavailableError("resizeToPng"),
    );
    const result = loadNativeImages([file], {});
    await expect(result).rejects.toThrow(NativeImageInputError);
    await expect(result).rejects.toThrow("图片处理服务暂不可用");
  });

  it("does not inherit the image_reading tool's ten-image limit", async () => {
    const file = await fixture();
    expect(await loadNativeImages(Array.from({ length: 11 }, () => file), {})).toHaveLength(11);
  });
});

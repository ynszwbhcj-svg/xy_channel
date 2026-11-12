import fs from "node:fs/promises";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { detectAndLoadAgentHarnessPromptImages } from "openclaw/plugin-sdk/agent-harness-runtime";
import { detectMime, isImageProcessorUnavailableError, MAX_IMAGE_BYTES, resizeToPng } from "openclaw/plugin-sdk/media-runtime";

export interface NativeImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export class NativeImageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeImageInputError";
  }
}

/** Keep the channel's download/read cap aligned with the installed runtime. */
export const NATIVE_IMAGE_MAX_BYTES = MAX_IMAGE_BYTES;
// Validation needs real pixel decoding, but its output can stay tiny. The SDK
// also limits decoded input to MAX_IMAGE_INPUT_PIXELS (25 megapixels).
const VALIDATION_MAX_SIDE = 64;

/**
 * Turn downloaded attachments into actual image content, before dispatch starts.
 * Decode each image before the runtime's header-based resize fast path. The
 * validation preview is discarded so original image/animation bytes survive.
 * Empty prompt avoids path re-detection; the runtime applies its normal image
 * resize policy to existingImages. Media* retains the
 * original attachment references and imageOrder marks these as inline images.
 */
export async function loadNativeImages(
  files: ReadonlyArray<{ path: string; name: string }>,
  config: ClawdbotConfig,
): Promise<NativeImageContent[]> {
  const images: NativeImageContent[] = [];
  for (const file of files) {
    try {
      const stat = await fs.stat(file.path);
      if (!stat.isFile() || stat.size === 0 || stat.size > NATIVE_IMAGE_MAX_BYTES) {
        throw new NativeImageInputError(`图片“${file.name}”为空或超过大小限制，请压缩后重试。`);
      }
      const buffer = await fs.readFile(file.path);
      if (buffer.byteLength === 0 || buffer.byteLength > NATIVE_IMAGE_MAX_BYTES) {
        throw new NativeImageInputError(`图片“${file.name}”为空或超过大小限制，请压缩后重试。`);
      }
      // Sniff bytes without trusting the filename or client-provided MIME.
      const mimeType = await detectMime({ buffer });
      if (!mimeType?.startsWith("image/")) {
        throw new NativeImageInputError(`图片“${file.name}”的内容或格式无效，请重新上传。`);
      }
      try {
        await resizeToPng({ buffer, maxSide: VALIDATION_MAX_SIDE, withoutEnlargement: true });
      } catch (err) {
        if (isImageProcessorUnavailableError(err)) {
          throw new NativeImageInputError("图片处理服务暂不可用，请稍后重试。");
        }
        throw new NativeImageInputError(`图片“${file.name}”无法解码或超过像素限制，请重新上传。`);
      }
      images.push({ type: "image", data: buffer.toString("base64"), mimeType });
    } catch (err) {
      if (err instanceof NativeImageInputError) throw err;
      throw new NativeImageInputError(`图片“${file.name}”读取失败，请重新上传。`);
    }
  }
  if (images.length === 0) return [];

  const result = await detectAndLoadAgentHarnessPromptImages({
    prompt: "",
    workspaceDir: process.cwd(),
    model: { input: ["text", "image"] },
    existingImages: images,
    imageOrder: images.map(() => "inline"),
    config,
  });
  if (result.images.length !== images.length) {
    throw new NativeImageInputError("部分图片无法解析或超过模型输入限制，请检查图片后重试。");
  }
  return result.images;
}

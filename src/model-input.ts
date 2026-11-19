/** Per-message model input policy supplied by Xiaoyi clients. */
export type XYModelInput = "text" | "image";

export interface ModelInputCapabilities {
  input: XYModelInput[];
  supportsNativeImages: boolean;
  source: "request" | "missing" | "invalid";
}

/** Missing/invalid declarations deliberately do not inherit model capabilities. */
export function resolveModelInput(raw: unknown): ModelInputCapabilities {
  const source = raw === undefined
    ? "missing"
    : Array.isArray(raw) && raw.every((value) => typeof value === "string")
      ? "request"
      : "invalid";
  const supportsNativeImages = source === "request" && (raw as string[]).includes("image");
  return {
    input: supportsNativeImages ? ["text", "image"] : ["text"],
    supportsNativeImages,
    source,
  };
}

/** MIME first, with an extension fallback for older clients omitting MIME. */
export function isImageAttachment(file: { name?: string; path?: string; mimeType?: string }): boolean {
  const mime = file.mimeType?.trim().toLowerCase();
  if (mime?.startsWith("image/")) return true;
  // An explicit non-image MIME wins over a misleading file extension.
  if (mime && mime !== "application/octet-stream") return false;
  return /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(file.name || file.path || "");
}

export interface ModelSelection {
  modelName?: string | null;
  modelCapabilities: ModelInputCapabilities;
}

function comparableModelName(value: string | null | undefined): string | undefined {
  const name = value?.trim();
  if (!name || name.toLowerCase() === "none") return undefined;
  return name.replace(/^xiaoyiprovider\//i, "");
}

/** Omitted modelName retains existing session selection; omitted input never does. */
export function modelSelectionChanged(active: ModelSelection | undefined, incoming: ModelSelection): boolean {
  if (!active) {
    return Boolean(comparableModelName(incoming.modelName)) || incoming.modelCapabilities.supportsNativeImages;
  }
  const nextName = comparableModelName(incoming.modelName);
  return (nextName !== undefined && nextName !== comparableModelName(active.modelName)) ||
    incoming.modelCapabilities.supportsNativeImages !== active.modelCapabilities.supportsNativeImages;
}

export function inheritSelectedModelName(active: ModelSelection | undefined, incoming: ModelSelection): ModelSelection {
  return {
    modelName: comparableModelName(incoming.modelName) ?? comparableModelName(active?.modelName),
    modelCapabilities: { ...incoming.modelCapabilities, input: [...incoming.modelCapabilities.input] },
  };
}

/**
 * Model input capability resolution for dynamically selected Xiaoyi models.
 *
 * OpenClaw only loads and forwards native image blocks when the resolved
 * model declares `input: ["text", "image"]`. Unknown models deliberately
 * stay text-only so an image is never sent to a model without an explicit
 * capability declaration.
 */

export type XYModelInput = "text" | "image";

export type ModelCapabilitySource =
  | "provider-model"
  | "channel-config"
  | "channel-default"
  | "conservative-default";

export interface ResolvedModelCapabilities {
  input: XYModelInput[];
  supportsNativeImages: boolean;
  source: ModelCapabilitySource;
}

export interface ResolveModelCapabilitiesParams {
  modelId: string;
  config?: unknown;
  providerConfig?: unknown;
  nativeImageModels?: readonly string[];
}

export type EffectiveModelSource = "explicit" | "session" | "default" | "unknown";

export interface EffectiveModelResolution {
  modelName?: string;
  source: EffectiveModelSource;
}

export interface ResolveEffectiveModelNameParams {
  explicitModelName?: unknown;
  sessionModelName?: unknown;
  defaultModelName?: unknown;
}

/** Known multimodal model IDs used when the channel option is omitted. */
export const DEFAULT_NATIVE_IMAGE_MODELS = ["Kimi_K3"] as const;

const VALID_INPUTS = new Set<XYModelInput>(["text", "image"]);

function normalizeModelId(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Normalize model values supplied by A2A, the session store, or config. */
export function normalizeModelName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") return undefined;

  // OpenClaw default/session refs can be provider-qualified, while A2A sends
  // the bare dynamic model ID expected by xiaoyiprovider.
  return trimmed.replace(/^xiaoyiprovider\//i, "");
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

/**
 * Resolve the model that is actually in effect for this turn.
 *
 * A2A image turns currently often omit modelName, so the persisted OpenClaw
 * session override is the authoritative fallback. If the client changes the
 * UI model and its first new turn still omits modelName, the server cannot
 * observe that change and will necessarily retain the previous session model.
 */
export function resolveEffectiveModelName(
  params: ResolveEffectiveModelNameParams,
): EffectiveModelResolution {
  const explicitModelName = normalizeModelName(params.explicitModelName);
  if (explicitModelName) return { modelName: explicitModelName, source: "explicit" };

  const sessionModelName = normalizeModelName(params.sessionModelName);
  if (sessionModelName) return { modelName: sessionModelName, source: "session" };

  const defaultModelName = normalizeModelName(params.defaultModelName);
  if (defaultModelName) return { modelName: defaultModelName, source: "default" };

  return { source: "unknown" };
}

/** Read the configured OpenClaw default model ID, if one is available. */
export function resolveConfiguredDefaultModelName(config: unknown): string | undefined {
  const root = asRecord(config);
  const defaults = asRecord(asRecord(root?.agents)?.defaults);
  const configuredModel = defaults?.model;
  const rawDefault = typeof configuredModel === "string"
    ? configuredModel
    : asRecord(configuredModel)?.primary;
  const normalized = normalizeModelName(rawDefault);
  if (!normalized || typeof rawDefault !== "string") return undefined;

  // Do not reinterpret another provider's qualified default as a Xiaoyi
  // dynamic model ID. Bare IDs remain valid for legacy configurations.
  if (rawDefault.includes("/") && !/^xiaoyiprovider\//i.test(rawDefault.trim())) return undefined;
  return normalized;
}

/** Read the persisted model override/model value from an OpenClaw session entry. */
export function resolveSessionEntryModelName(sessionEntry: unknown): string | undefined {
  const entry = asRecord(sessionEntry);
  if (!entry) return undefined;
  return normalizeModelName(entry.modelOverride) ?? normalizeModelName(entry.model);
}

function readProviderConfig(config: unknown, providerConfig: unknown): Record<string, any> | undefined {
  const direct = asRecord(providerConfig);
  if (direct) return direct;

  const root = asRecord(config);
  return asRecord(asRecord(asRecord(root?.models)?.providers)?.xiaoyiprovider);
}

function readExplicitModelInput(
  modelId: string,
  config: unknown,
  providerConfig: unknown,
): XYModelInput[] | undefined {
  const models = readProviderConfig(config, providerConfig)?.models;
  if (!Array.isArray(models)) return undefined;

  const normalizedId = normalizeModelId(modelId);
  const configuredModel = models.find((candidate: unknown) => {
    const record = asRecord(candidate);
    return normalizeModelId(record?.id) === normalizedId;
  });
  const rawInput = asRecord(configuredModel)?.input;
  if (!Array.isArray(rawInput)) return undefined;

  const input = rawInput
    .map((value: unknown) => normalizeModelId(value))
    .filter((value: string): value is XYModelInput => VALID_INPUTS.has(value as XYModelInput));

  // A model always accepts text in this OpenAI-compatible provider. Preserve
  // explicit non-text modalities while normalizing incomplete config entries.
  return Array.from(new Set<XYModelInput>(["text", ...input]));
}

function readNativeImageModels(params: ResolveModelCapabilitiesParams): {
  modelIds: readonly string[];
  source: "channel-config" | "channel-default";
} {
  if (params.nativeImageModels) {
    return { modelIds: params.nativeImageModels, source: "channel-config" };
  }

  const root = asRecord(params.config);
  const channel = asRecord(asRecord(root?.channels)?.["xiaoyi-channel"]);
  if (Array.isArray(channel?.nativeImageModels)) {
    return {
      modelIds: channel.nativeImageModels.filter((value: unknown): value is string => typeof value === "string"),
      source: "channel-config",
    };
  }

  return { modelIds: DEFAULT_NATIVE_IMAGE_MODELS, source: "channel-default" };
}

/** Resolve native input modalities for one dynamically selected model. */
export function resolveModelCapabilities(
  params: ResolveModelCapabilitiesParams,
): ResolvedModelCapabilities {
  const explicitInput = readExplicitModelInput(params.modelId, params.config, params.providerConfig);
  if (explicitInput) {
    return {
      input: explicitInput,
      supportsNativeImages: explicitInput.includes("image"),
      source: "provider-model",
    };
  }

  const nativeImageModels = readNativeImageModels(params);
  const normalizedId = normalizeModelId(params.modelId);
  const supportsNativeImages = nativeImageModels.modelIds.some(
    (candidate) => normalizeModelId(candidate) === normalizedId,
  );

  return {
    input: supportsNativeImages ? ["text", "image"] : ["text"],
    supportsNativeImages,
    source: supportsNativeImages ? nativeImageModels.source : "conservative-default",
  };
}

/** Return true when an inbound attachment is an image. */
export function isImageAttachment(file: { name?: string; path?: string; mimeType?: string }): boolean {
  if (file.mimeType?.trim().toLowerCase().startsWith("image/")) return true;
  const candidatePath = file.name || file.path || "";
  return /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(candidatePath);
}

/** Hide the image-reading fallback when the active model receives native images. */
export function filterToolsForModelCapabilities<T extends { name?: string }>(
  tools: readonly T[],
  capabilities?: ResolvedModelCapabilities,
): T[] {
  if (!capabilities?.supportsNativeImages) return [...tools];
  return tools.filter((tool) => tool.name !== "image_reading");
}

/** Decide whether an active-run image turn must bypass text-only live steer. */
export function shouldPreserveImageForQueuedTurn(params: {
  isUpdate: boolean;
  hasImageAttachment: boolean;
  capabilities?: ResolvedModelCapabilities;
}): boolean {
  return params.isUpdate &&
    params.hasImageAttachment &&
    params.capabilities?.supportsNativeImages === true;
}

/**
 * Force an image-bearing active-session turn into OpenClaw's follow-up queue.
 * Unlike live steer injection, a queued follow-up retains its image blocks.
 */
export function withImagePreservingFollowupQueue<T extends Record<string, any>>(cfg: T): T {
  return {
    ...cfg,
    messages: {
      ...asRecord(cfg.messages),
      queue: {
        ...asRecord(asRecord(cfg.messages)?.queue),
        mode: "followup",
      },
    },
  };
}

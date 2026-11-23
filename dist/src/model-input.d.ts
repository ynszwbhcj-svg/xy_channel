/** Per-message model input policy supplied by Xiaoyi clients. */
export type XYModelInput = "text" | "image";
export interface ModelInputCapabilities {
    input: XYModelInput[];
    supportsNativeImages: boolean;
    source: "request" | "missing" | "invalid";
}
/** Missing/invalid declarations deliberately do not inherit model capabilities. */
export declare function resolveModelInput(raw: unknown): ModelInputCapabilities;
/** MIME first, with an extension fallback for older clients omitting MIME. */
export declare function isImageAttachment(file: {
    name?: string;
    path?: string;
    mimeType?: string;
}): boolean;
export interface ModelSelection {
    modelName?: string | null;
    modelCapabilities: ModelInputCapabilities;
}
/** Omitted modelName retains existing session selection; omitted input never does. */
export declare function modelSelectionChanged(active: ModelSelection | undefined, incoming: ModelSelection): boolean;
export declare function inheritSelectedModelName(active: ModelSelection | undefined, incoming: ModelSelection): ModelSelection;

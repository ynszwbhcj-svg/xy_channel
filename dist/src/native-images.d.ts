import type { ClawdbotConfig } from "openclaw/plugin-sdk";
export interface NativeImageContent {
    type: "image";
    data: string;
    mimeType: string;
}
export declare class NativeImageInputError extends Error {
    constructor(message: string);
}
/** Keep the channel's download/read cap aligned with the installed runtime. */
export declare const NATIVE_IMAGE_MAX_BYTES: number;
/**
 * Turn downloaded attachments into actual image content, before dispatch starts.
 * Decode each image before the runtime's header-based resize fast path. The
 * validation preview is discarded so original image/animation bytes survive.
 * Empty prompt avoids path re-detection; the runtime applies its normal image
 * resize policy to existingImages. Media* retains the
 * original attachment references and imageOrder marks these as inline images.
 */
export declare function loadNativeImages(files: ReadonlyArray<{
    path: string;
    name: string;
}>, config: ClawdbotConfig): Promise<NativeImageContent[]>;

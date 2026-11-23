import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
/**
 * Check if an errorMessage indicates a retryable provider error by type.
 * Covers both the known transient server/rate-limit texts (from the upstream
 * LLM gateway) and undici/Node transport-termination errors (the stream was
 * cut or timed out mid-flight), which are safe and desirable to retry.
 * Exported for unit tests.
 */
export declare function isRetryableProviderError(message: string | undefined): boolean;
export declare function applySelfEvolutionPrompt(systemPrompt: string | undefined, enabled: boolean): string;
export declare const xiaoyiProvider: ProviderPlugin;

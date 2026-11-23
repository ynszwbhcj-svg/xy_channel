/**
 * Manages dynamic configuration updates that can change at runtime.
 * Specifically handles pushId which can be updated per-session.
 */
declare class ConfigManager {
    private get sessionPushIds();
    private get globalPushId();
    private set globalPushId(value);
    /**
     * Update push ID for a specific session.
     */
    updatePushId(sessionId: string, pushId: string): void;
    /**
     * Get push ID for a session (falls back to global if not found).
     */
    getPushId(sessionId?: string): string | null;
    /**
     * Clear push ID for a session.
     */
    clearSession(sessionId: string): void;
    /**
     * Clear all cached push IDs.
     */
    clear(): void;
}
export declare const configManager: ConfigManager;
export {};

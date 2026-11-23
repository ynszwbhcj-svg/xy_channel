declare class SelfEvolutionManager {
    /**
     * Synchronous read for hot paths (e.g. tool_result_persist — must not return a Promise).
     */
    isEnabledSync(): boolean;
    private parseEnabledFromEnvText;
    isEnabled(): Promise<boolean>;
}
export declare const selfEvolutionManager: SelfEvolutionManager;
export {};

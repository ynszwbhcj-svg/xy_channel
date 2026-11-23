declare class DynamicSkillTriggerManager {
    /** 同步读取，用于 hooks 热路径 */
    isEnabledSync(): boolean;
    /** 异步读取，用于 provider 等异步路径 */
    isEnabled(): Promise<boolean>;
}
export declare const dynamicSkillTriggerManager: DynamicSkillTriggerManager;
export {};

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
export default function register(api: OpenClawPluginApi): void;
export declare function buildSkillScanPayload(targetHash: string, downloadUrl: string, skillType: string, skillContent: string, config: {
    apiKey: string;
    uid: string;
    serviceUrl: string;
}, sessionID: string): {
    taskID: string;
    sessionID: string;
    interActionID: number;
    uid: string;
    businessID: string;
    reqTime: string;
    action: string;
    checkPoint: number;
    message: object;
};

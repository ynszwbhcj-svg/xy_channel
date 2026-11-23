import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { ApiResponse } from './constants.js';
export interface CallApiPayload {
    sceneID: string;
    [key: string]: unknown;
}
export declare function callApi(payload: CallApiPayload, api: OpenClawPluginApi, sessionId: string): Promise<ApiResponse>;
export declare function callSkillScanApi(url_suffix: string, payload: object, api: OpenClawPluginApi, sessionId: string): Promise<ApiResponse>;

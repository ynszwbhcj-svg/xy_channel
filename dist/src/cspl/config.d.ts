import { HttpHeaders } from './constants.js';
export interface ApiConfig {
    url: string;
    timeout: number;
}
export interface Config {
    api: ApiConfig;
    headers?: HttpHeaders;
    uid: string;
    apiKey: string;
    skillId: string;
    requestFrom: string;
    textSource: string;
}
export declare function getConfig(api: any): Config;

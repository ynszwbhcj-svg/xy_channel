export interface HttpHeaders {
    'x-hag-trace-id': string;
    'x-uid': string;
    'x-api-key': string;
    'x-request-from': string;
    'x-skill-id': string;
    'content-type': string;
    [key: string]: string;
}
export interface ApiPayload {
    questionText: string;
    textSource: string;
    action: string;
}
export declare const RESULT_CODE_MAP: Record<number, string>;
export interface NewRequestPayload {
    taskID: string;
    sessionID: string;
    uid: string;
    businessID: string;
    sceneID: string;
    checkPoint: number;
    interActionID: number;
    loginType?: string;
    reqTime?: string;
    message: object;
}
export interface NewApiResponse {
    data: {
        taskID: string;
        resultCode: number;
        resultMessage?: string;
        securityResult: string;
        riskLabels?: string[];
        riskDegree?: Array<{
            riskLabel: string;
            score: number;
        }>;
        riskLabelCount?: Array<{
            riskLabel: string;
            count: number;
        }>;
        actionRiskResult?: {
            riskScore: number;
            riskTag: string[];
        };
    };
    retCode?: string;
    retMsg?: string;
}
export interface ApiResponse {
    [key: string]: any;
}
export declare const MIN_TEXT_LENGTH = 0;
export declare const MAX_TEXT_LENGTH = 4096;
export declare const MAX_TOTAL_LENGTH = 40960;
export declare const regex: RegExp;
export declare const SECURITY_NOTICE: string;
export declare const DEFAULT_HTTP_PORT = 80;
export declare const DEFAULT_HTTPS_PORT = 443;
export declare const HTTP_STATUS_BAD_REQUEST = 400;
export declare const ENV_FILE_PATH = "/home/sandbox/.openclaw/.xiaoyienv";
export declare const API_URL_SUFFIX = "/celia-claw/v1/rest-api/skill/execute";
export declare const REQUIRED_ENV_VARS: string[];
export declare const MAX_TRACE_ID_LENGTH = 64;
export declare const ALLOWED_TOOLS: string[];
export declare const STEER_ABORT_MESSAGE = "\u5F53\u524D\u884C\u4E3A\u5B58\u5728\u5B89\u5168\u9690\u60A3\uFF0C\u7EC8\u6B62\u6240\u6709\u64CD\u4F5C\uFF0C\u5E76\u4E14\u5728\u6700\u7EC8\u56DE\u590D\u4E2D\u8BF4\u660E\uFF0C\u8BC6\u522B\u5230\u5F53\u524D\u6D41\u7A0B\u4E2D\u5B58\u5728\u6F5C\u5728\u5B89\u5168\u98CE\u9669\uFF0C\u5DF2\u5E2E\u60A8\u4E2D\u6B62\u5F53\u524D\u6D41\u7A0B\uFF0C\u8BF7\u6E05\u7A7A\u4E0A\u4E0B\u6587\u540E\u91CD\u8BD5";
export declare const MAX_FILE_COUNT = 10;
export declare const MAX_COMMAND_LENGTH = 1024;
export declare const CODE_FILE_EXTENSIONS: string[];
export declare const FILE_EXTENSION_REGEX: RegExp;
export declare const TOOL_INPUT_DEFAULT: {
    readonly subSceneID: "TOOL_INPUT";
    readonly tool: "";
    readonly hash: "";
    readonly url: "";
    readonly size: 0;
    readonly source: "";
    readonly content: "";
};
export declare const TOOL_INPUT_ACTION = "TOOL_INPUT_SCAN";
export declare const TOOL_OUTPUT_ACTION = "TOOL_OUTPUT_SCAN";
export declare const MAX_TIMES = 3;
export declare const CONNECT_TIMEOUT = 15000;
export declare const READ_TIMEOUT = 300000;
export declare const EXPIRE_TIME = 259200;
export declare const OSMS_PREPARE_URL = "/osms/v1/file/manager/prepare";
export declare const OSMS_COMPLETE_URL = "/osms/v1/file/manager/completeAndQuery";
export declare const TEMPORARY_MATERIAL_PACKAGE = "TEMPORARY_MATERIAL_PACKAGE";
export declare const FILE_OWNER_UID = "openclaw";
export declare const FILE_OWNER_TEAM_ID = "openclaw";
export interface UploadInfo {
    url: string;
    headers: Record<string, string>;
}
export interface PrepareResponse {
    objectId: string;
    draftId: string;
    uploadInfos: UploadInfo[];
}
export interface CompleteResponse {
    fileDetailInfo?: {
        url: string;
    };
}

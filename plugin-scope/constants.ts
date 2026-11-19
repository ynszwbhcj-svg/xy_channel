/*
 * 版权所有 (c) 华为技术有限公司 2026-2026
 */

// Types matching PluginHookBeforeInstallEvent / PluginHookBeforeInstallResult in the SDK
// (not yet publicly exported from openclaw/plugin-sdk@2026.6.6, defined locally)
// findings 以宿主 SDK 类型为准(ruleId/file/line 必填),同时携带上游新增的 category 字段
export interface PluginInstallFinding {
    ruleId: string;
    severity: "info" | "warn" | "critical";
    category?: string;
    file: string;
    line: number;
    message: string;
}

export interface BeforeInstallEvent {
    targetType: string;
    targetName: string;
    sourcePath: string;
    sourcePathKind: string;
    origin?: string;
    request: { kind: string; mode: string };
    builtinScan: { status: string; scannedFiles: number; critical: number; warn: number; info: number; findings: PluginInstallFinding[] };
    skill?: { installId: string };
    plugin?: { pluginId: string; contentType: string };
}

export interface BeforeInstallResult {
    block?: boolean;
    blockReason?: string;
    findings?: PluginInstallFinding[];
}

export interface BeforeInstallContext {
    targetType: string;
    requestKind: string;
    origin?: string;
    sessionId?: string;
}

export interface HttpHeaders {
    'x-hag-trace-id': string;
    'sessionId': string;
    'x-sandbox-id': string;
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
    extra?: string;
}

export interface ApiResponse {
    [key: string]: any;
}
// OBS上传接口定义
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

// OSMS请求相关常量
export const TEMPORARY_MATERIAL_PACKAGE = 'TEMPORARY_MATERIAL_PACKAGE';
export const FILE_OWNER_UID = 'openclaw';
export const FILE_OWNER_TEAM_ID = 'openclaw';

export const MIN_TEXT_LENGTH = 0;
export const MAX_TEXT_LENGTH = 4096;

export const MAX_TOTAL_LENGTH = 40960;
export const regex = /[^\u4e00-\u9fa5a-zA-Z0-9\s\.,!?;:，。！？；：""''（）()\[\]【】]/;

export const DEFAULT_HTTP_PORT = 80;
export const HTTP_STATUS_BAD_REQUEST = 400;
export const DEFAULT_HTTPS_PORT = 443;
export const CONFIG_FILE_NAME = 'configs.json';
export const ENV_FILE_PATH = '/home/sandbox/.openclaw/.xiaoyienv';
export const API_URL_SUFFIX = '/celia-claw/v1/rest-api/skill/execute';
export const SCENE_ID = 'SKILL_SCAN';
// OBS上传相关常量
export const MAX_TIMES = 3;
export const CONNECT_TIMEOUT = 15000;
export const READ_TIMEOUT = 300000;
export const EXPIRE_TIME = 259200;
// OSMS接口路径
export const OSMS_PREPARE_URL_SUFFIX = '/osms/v1/file/manager/prepare';
export const OSMS_COMPLETE_URL_SUFFIX = '/osms/v1/file/manager/completeAndQuery';
// 兼容 upload_file.ts 引用的命名（与 _SUFFIX 同值）
export const OSMS_PREPARE_URL = OSMS_PREPARE_URL_SUFFIX;
export const OSMS_COMPLETE_URL = OSMS_COMPLETE_URL_SUFFIX;
export const REQUIRED_ENV_VARS = ['PERSONAL-API-KEY', 'PERSONAL-UID', 'SERVICE_URL'];

export const ALLOWED_TOOLS = ['web_fetch', 'read', 'pdf'];

export const IGNORE_DIRS = new Set([".github", ".git", "__pycache__", "tests"]);
export const IGNORE_FILES = new Set([
    "LICENSE.txt",
    "LICENSE",
    "README.md",
    "_meta.json",
    "pytest.ini",
    "requirements.txt",
    ".gitignore",
    ".env.example",
]);

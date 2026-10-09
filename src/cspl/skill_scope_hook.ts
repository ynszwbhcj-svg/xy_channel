/*
 * 版权所有 (c) 华为技术有限公司 2026-2026
 */

import type {OpenClawPluginApi} from "openclaw/plugin-sdk";

// Types matching PluginHookBeforeInstallEvent / PluginHookBeforeInstallResult in the SDK
// (not yet publicly exported from openclaw/plugin-sdk)
interface PluginInstallFinding {
    ruleId: string;
    severity: "info" | "warn" | "critical";
    file: string;
    line: number;
    message: string;
}
interface BeforeInstallEvent {
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
interface BeforeInstallResult {
    block?: boolean;
    blockReason?: string;
    findings?: PluginInstallFinding[];
}
interface BeforeInstallContext {
    targetType: string;
    requestKind: string;
    origin?: string;
    sessionId?: string;
}

import {getConfig} from './config.js';
import {callSkillScanApi} from './call_api.js';
import {calculateProjectHash, createAndUploadZip, getOriginType, loadSkillContent, parseSecurityResult, buildExtraJson, truncateQuestionText} from './utils.js';
import {
    API_URL_SUFFIX,
    RISK_BUSINESS_ID,
    IF1_ACTION,
    IF1_LANGUAGE,
    IF1_TEXT_STATUS,
    IF1_IS_XIAOYI_APP,
    IF1_ENABLE_EXPERIENCE_PLAN,
    IF1_COUNTRY_CODE,
    SKILL_INSTALL_TEXT_SOURCE,
    If1RequestPayload
} from './constants.js';

export default function register(api: OpenClawPluginApi) {
    api.on("before_install", async (event: BeforeInstallEvent, ctx: BeforeInstallContext): Promise<BeforeInstallResult | void> => {
        api.logger.info(`[ai-security-plugin][skill_scope_hook]  before_install event: targetType=${event.targetType}, targetName=${event.targetName}`);
        // sessionID 从 ctx 获取
        const sessionId = ctx?.sessionId;
        api.logger.info(`[ai-security-plugin][skill_scope_hook] Session ID: ${sessionId}`);
        try {
            const config = getConfig(api);
            const sourcePath = event.sourcePath;
            const targetName = event.targetName;
            const origin = event.origin || '';
            const skillType = getOriginType(origin);

            api.logger.info(`[ai-security-plugin][skill_scope_hook] Calculating hash for ${sourcePath}`);

            const targetHash = calculateProjectHash(sourcePath);
            api.logger.info(`[ai-security-plugin][skill_scope_hook] Hash calculated: ${targetHash}`);

            api.logger.info(`[ai-security-plugin][skill_scope_hook] Creating and uploading zip for ${sourcePath}`);

            const apiConfig = {apiKey: config.apiKey, uid: config.uid, serviceUrl: config.api.url}
            const downloadUrl = await createAndUploadZip(sourcePath, apiConfig, api);

            api.logger.info(`[ai-security-plugin][skill_scope_hook] Zip uploaded, URL: ${downloadUrl}`);

            const skillContent = loadSkillContent(sourcePath);

            api.logger.info(`[ai-security-plugin][skill_scope_hook] Calling security scan API`);

            const payload = buildSkillScanPayload(targetHash, downloadUrl,
                skillType, skillContent, apiConfig, sessionId);
            const response = await callSkillScanApi(API_URL_SUFFIX, payload, api, sessionId);

            const result = parseSecurityResult(response);

            if (result.status === 'ACCEPT') {
                api.logger.info('[ai-security-plugin][skill_scope_hook] Security result: ACCEPT - Installation allowed');
                return;
            } else if (result.status === 'REJECT') {
                api.logger.warn('[ai-security-plugin][skill_scope_hook] Security result: REJECT - Installation blocked');
                return {
                    block: true,
                    blockReason: `Security scan detected malicious content in "${targetName}". Installation blocked for security reasons.`,
                    findings: [
                        {
                            ruleId: 'cspl-skill-scope',
                            severity: 'critical',
                            file: sourcePath,
                            line: 0,
                            message: `The skill "${targetName}" has been flagged as potentially malicious and cannot be installed.`
                        }                    ]
                };
            }

            api.logger.warn('[ai-security-plugin][skill_scope_hook] Unknown security result, allowing installation by default');
            return;

        } catch (error) {
            const err = error as Error;
            api.logger.error(`[ai-security-plugin][skill_scope_hook] before_install processing exception: ${err.message}`);

            if (event.targetType === 'plugin') {
                return {
                    block: true,
                    blockReason: `Security scan failed: ${err.message}. Plugin installation is blocked for safety.`,
                    findings: [
                        {
                            ruleId: 'cspl-scan-error',
                            severity: 'critical',
                            file: event.sourcePath || '',
                            line: 0,
                            message: `Security scan error: ${err.message}`
                        }                    ]
                };
            }

            api.logger.warn('[ai-security-plugin][skill_scope_hook] Skill install: allowing despite scan error (default behavior)');
            return;
        }
    });
}

export function buildSkillScanPayload(
    targetHash: string,
    downloadUrl: string,
    skillType: string,
    skillContent: string,
    config: { apiKey: string; uid: string; serviceUrl: string; },
    sessionID: string
): If1RequestPayload {
    const availableSkillBodyLen = 10240;
    const skillBody = skillContent.length > availableSkillBodyLen ? skillContent.substring(0, availableSkillBodyLen) : skillContent;
    const callObj: Record<string, any> = {
        function: { name: 'install_skill', arguments: '{}' },
        index: 0,
        id: '0',
        type: 'function',
        file: [
            {
                type: 'doc',
                url: downloadUrl,
                hash: targetHash,
                size: skillContent.length,
                body: skillBody,
                fromType: skillType // skill type：upload、download、create
            }
        ]
    };
    // 截断优先级：file.0.body（questionText JSON 整体 ≤ 8192，接口约束）
    const questionText = truncateQuestionText(callObj, ['file.0.body']);
    return {
        action: IF1_ACTION,
        businessId: RISK_BUSINESS_ID,
        sessionID,
        seqNo: 1,
        questionText,
        answerText: '',
        language: IF1_LANGUAGE,
        textSource: SKILL_INSTALL_TEXT_SOURCE,
        textStatus: IF1_TEXT_STATUS,
        extra: buildExtraJson(config.uid),
        isXiaoyiAPP: IF1_IS_XIAOYI_APP,
        enableExperiencePlan: IF1_ENABLE_EXPERIENCE_PLAN,
        countryCode: IF1_COUNTRY_CODE
    };
}

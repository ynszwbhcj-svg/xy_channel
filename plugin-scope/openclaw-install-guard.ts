#!/usr/bin/env node
/*
 * 版权所有 (c) 华为技术有限公司 2026-2026
 */

import {spawn} from "node:child_process";
import crypto from "node:crypto";

import {getConfig} from './config.js';
import {callSkillScanApi} from './call_api.js';
import {API_URL_SUFFIX} from './constants.js';
import {buildSkillScanPayload} from './skill_scope_hook.js';
import {
    calculateProjectHash,
    createAndUploadZip,
    getOriginType,
    loadTargetContent,
    parseSecurityResult,
    resolveCallName
} from './utils.js';

interface ScanOutcome {
    decision: "ACCEPT" | "REJECT" | "error";
    sha256: string;
    error?: string;
}

const args = process.argv.slice(2);
const originFlag = args.indexOf("--origin");
const origin = originFlag >= 0 ? args[originFlag + 1] : "download";
// 修复上游 bug:未传 --origin 时 originFlag 为 -1,filter 条件 i !== 0 会误删 command[0],
// 导致 isInstall 永远为 false,所有安装命令不做预检直接透传
const command = originFlag >= 0 ? args.filter((_, i) => i !== originFlag && i !== originFlag + 1) : args;
const isInstall = command[0] === "plugins" || command[0] === "skills";
const source = command.find(
    (a) => !a.startsWith("-") && (a.includes("/") || a.startsWith(".")),
);
const openclawBin = process.env.OPENCLAW_BIN || "openclaw";

if (!isInstall || !source) {
    const child = spawn(openclawBin, command, {
        stdio: "inherit",
        env: process.env,
    });
    child.on("exit", (code) => process.exit(code ?? 1));
    child.on("error", (error) => {
        console.error(error.message);
        process.exit(1);
    });
} else {
    let outcome: ScanOutcome;
    try {
        outcome = await scanWithPluginScope(source, origin);
    } catch (error) {
        outcome = {
            decision: "error",
            sha256: "",
            error: String((error as Error)?.message || error),
        };
    }
    console.error(
        JSON.stringify(
            {
                event: "toolscope_preflight",
                source,
                decision: outcome.decision,
                sha256: outcome.sha256,
                error: outcome.error,
            },
            null,
            2,
        ),
    );
    if (outcome.decision !== "ACCEPT") {
        process.exit(outcome.decision === "REJECT" ? 10 : 20);
    }
    const child = spawn(openclawBin, command, {
        stdio: "inherit",
        env: process.env,
    });
    child.on("exit", (code) => process.exit(code ?? 1));
    child.on("error", (error) => {
        console.error(error.message);
        process.exit(1);
    });
}

async function scanWithPluginScope(source: string, origin: string): Promise<ScanOutcome> {
    const compatApi = {
        logger: {info: console.log, warn: console.warn, error: console.error},
    } as any;

    const config = getConfig(compatApi);
    const apiConfig = {
        apiKey: config.apiKey,
        uid: config.uid,
        serviceUrl: config.api.url,
    };

    console.error(`[openclaw-install-guard] Calculating hash for ${source}`);
    const targetHash = calculateProjectHash(source);

    console.error(`[openclaw-install-guard] Creating and uploading zip for ${source}`);
    const downloadUrl = await createAndUploadZip(source, apiConfig, compatApi);

    const {content: skillContent, manifestName} = loadTargetContent(source);
    const callName = resolveCallName(manifestName);
    const skillType = getOriginType(origin);
    const sessionId = crypto.randomUUID();

    console.error(`[openclaw-install-guard] Calling security scan API`);
    const payload = buildSkillScanPayload(
        targetHash,
        downloadUrl,
        skillType,
        skillContent,
        apiConfig,
        sessionId,
        callName,
    );
    const response = await callSkillScanApi(API_URL_SUFFIX, payload, compatApi, sessionId);

    const result = parseSecurityResult(response);
    return {decision: result.status, sha256: targetHash};
}

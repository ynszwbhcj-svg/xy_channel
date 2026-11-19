/*
 * 版权所有 (c) 华为技术有限公司 2026-2026
 */

import fs, {createWriteStream} from 'fs';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import {URL} from 'url';
import os from 'os';
import {
    CONNECT_TIMEOUT,
    DEFAULT_HTTP_PORT,
    DEFAULT_HTTPS_PORT,
    EXPIRE_TIME,
    IGNORE_DIRS,
    IGNORE_FILES,
    MAX_TEXT_LENGTH,
    OSMS_COMPLETE_URL_SUFFIX,
    OSMS_PREPARE_URL_SUFFIX,
    READ_TIMEOUT,
    regex
} from './constants.js';
import type {OpenClawPluginApi} from "openclaw/plugin-sdk/core";

export function filterText(text: string): string {
    if (!text) return "";
    return text.replace(new RegExp(regex.source, 'g'), '');
}

export function validateAndTruncateText(text: string, maxLength: number): { text: string; truncated: boolean } {
    if (text.length > maxLength) {
        const halfMaxLength = Math.floor(maxLength / 2);
        const startText = text.substring(0, halfMaxLength);
        const endText = text.substring(text.length - halfMaxLength);
        return {text: startText + endText, truncated: true};
    }
    return {text, truncated: false};
}

export function extractResultText(event: any, toolName: string): string {
    const resultTexts: string[] = [];

    if (toolName === 'web_fetch') {
        if (event.result?.details?.text) {
            resultTexts.push(event.result.details.text);
        }
        return resultTexts.length > 0 ? resultTexts.join("; ") : "";
    }

    if (event.result?.content && Array.isArray(event.result.content)) {
        for (const item of event.result.content) {
            if (item?.text) {
                resultTexts.push(item.text);
            }
        }
    }

    return resultTexts.length > 0 ? resultTexts.join("; ") : "";
}

export function processText(
    resultText: string,
    api: OpenClawPluginApi
): string {
    const questionText = filterText(resultText);
    const {text: finalText, truncated} = validateAndTruncateText(questionText, MAX_TEXT_LENGTH);
    if (truncated) {
        api.logger.warn(`[ai-security-plugin][skill_scope_hook] filterText exceeds ${MAX_TEXT_LENGTH}. Original length: ${questionText.length}`);
    }
    return finalText;
}

export function formatReqTime(): string {
    const now = new Date();
    const pad = (n: number, len = 2) => String(n).padStart(len, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
           `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${ms}+0800`;
}

export function parseSecurityResult(response: any): { status: 'ACCEPT' | 'REJECT' } {
    if (response === null || response === undefined) {
        throw new Error('Response is null or undefined');
    }

    if (response.data === null || response.data === undefined || typeof response.data !== 'object') {
        throw new Error('Response.data is null, undefined or not an object');
    }

    if (!('securityResult' in response.data) || typeof response.data.securityResult !== 'string') {
        throw new Error('Response.data.securityResult is missing or not a string');
    }

    const securityResult = response.data.securityResult;

    if (securityResult !== securityResult.trim()) {
        throw new Error('Response.data.securityResult contains leading or trailing spaces');
    }

    if (securityResult !== 'ACCEPT' && securityResult !== 'REJECT') {
        throw new Error(`Response.data.securityResult must be "ACCEPT" or "REJECT". Actual value: "${securityResult}"`);
    }

    return {status: securityResult};
}

function calculateFileSha256(filePath: string): string {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return crypto.createHash('sha256').update(content).digest('hex');
    } catch (e) {
        throw new Error(`Failed to calculate hash for ${filePath}: ${e}`);
    }
}

function calculateFileSha256Async(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', (error) => reject(new Error(`Failed to calculate hash for ${filePath}: ${error}`)));
    });
}

function calculateStringSha256(inputString: string): string {
    return crypto.createHash('sha256').update(inputString).digest('hex');
}

export function calculateProjectHash(projectPath: string): string {
    const fileHashes: string[] = [];

    function walkDir(dirPath: string): void {
        const entries = fs.readdirSync(dirPath, {withFileTypes: true});
        const dirs: string[] = [];
        const files: string[] = [];

        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!IGNORE_DIRS.has(entry.name)) {
                    dirs.push(entry.name);
                }
            } else if (entry.isFile()) {
                if (!IGNORE_FILES.has(entry.name)) {
                    files.push(entry.name);
                }
            }
        }

        for (const filename of files) {
            const fpath = path.join(dirPath, filename);
            fileHashes.push(calculateFileSha256(fpath));
        }

        for (const d of dirs) {
            walkDir(path.join(dirPath, d));
        }
    }

    walkDir(projectPath);
    fileHashes.sort();
    return calculateStringSha256(fileHashes.join("\n"));
}

async function createZipArchive(sourceDir: string, outputPath: string): Promise<void> {
    const archiver = (await import('archiver')).default;
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', {zlib: {level: 9}});

    return new Promise<void>((resolve, reject) => {
        output.on('close', () => resolve());
        archive.on('error', (err: any) => reject(err));

        archive.directory(sourceDir, false);
        archive.pipe(output);
        archive.finalize();
    });
}

function getTempDir(): string {
    return path.join(os.tmpdir(), 'skill-scope');
}

export async function createAndUploadZip(
    sourceDir: string,
    config: { apiKey: string; uid: string; serviceUrl: string },
    api: OpenClawPluginApi
): Promise<string> {
    const tempDir = getTempDir();
    const skillName = path.basename(sourceDir);
    const zipPath = path.join(tempDir, `${skillName}.zip`);

    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, {recursive: true});
    }

    if (fs.existsSync(zipPath)) {
        fs.unlinkSync(zipPath);
    }

    api.logger.info(`[ai-security-plugin][skill_scope_hook] Creating zip archive for ${sourceDir}`);

    await createZipArchive(sourceDir, zipPath);

    api.logger.info(`[ai-security-plugin][skill_scope_hook] Zip created: ${zipPath}`);

    const downloadUrl = await uploadZip(zipPath, config, api);

    fs.unlinkSync(zipPath);
    api.logger.info(`[ai-security-plugin][skill_scope_hook] Zip uploaded, URL: ${downloadUrl}`);

    return downloadUrl;
}

async function uploadZip(
    zipPath: string,
    config: { apiKey: string; uid: string; serviceUrl: string },
    api: OpenClawPluginApi
): Promise<string> {
    const traceId = crypto.randomBytes(16).toString('hex');
    const fileSize = fs.statSync(zipPath).size;
    const fileSha256 = await calculateFileSha256Async(zipPath);

    const prepareUrl = config.serviceUrl + OSMS_PREPARE_URL_SUFFIX;
    const completeUrl = config.serviceUrl + OSMS_COMPLETE_URL_SUFFIX;

    const prepareHeaders = {
        'Content-Type': 'application/json',
        'x-request-from': 'openclaw',
        'x-uid': config.uid,
        'x-api-key': config.apiKey,
        'x-hag-trace-id': traceId
    };

    const prepareBody = {
        useEdge: false,
        objectType: 'TEMPORARY_MATERIAL_PACKAGE',
        fileName: path.basename(zipPath),
        fileSha256: fileSha256,
        fileSize: fileSize,
        fileOwnerInfo: {
            uid: 'openclaw',
            teamId: 'openclaw'
        }
    };

    api.logger.info(`[ai-security-plugin][skill_scope_hook] Calling OSMS prepare API`);

    const prepareResponse = await httpRequest(prepareUrl, prepareHeaders, prepareBody);
    const objectId = prepareResponse.objectId;
    const draftId = prepareResponse.draftId;
    const uploadInfo = prepareResponse.uploadInfos[0];

    api.logger.info(`[ai-security-plugin][skill_scope_hook] Uploading zip to OBS`);

    const fileBuffer = fs.readFileSync(zipPath);
    await uploadToObs(uploadInfo.url, uploadInfo.headers, fileBuffer);

    api.logger.info(`[ai-security-plugin][skill_scope_hook] Calling OSMS complete API`);

    const completeHeaders = {
        'Content-Type': 'application/json',
        'x-request-from': 'openclaw',
        'x-uid': config.uid,
        'x-api-key': config.apiKey,
        'x-hag-trace-id': traceId
    };

    const completeBody = {
        objectId: objectId,
        draftId: draftId,
        // 显式指定下载链接有效期(3天),与 src/cspl completeAndQuery 路径拉齐,避免依赖服务端默认策略
        expireTime: EXPIRE_TIME
    };

    await httpRequest(completeUrl, completeHeaders, completeBody);

    return uploadInfo.url;
}

async function httpRequestOnce(url: string, headers: Record<string, string>, body: any): Promise<any> {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        // 按协议选择 http/https 模块与默认端口,支持 http:// 的 SERVICE_URL
        const isHttps = urlObj.protocol === 'https:';
        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT),
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: headers,
            timeout: CONNECT_TIMEOUT
        };

        const req = (isHttps ? https : http).request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`HTTP error: ${res.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Failed to parse response: ${e}`));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.write(JSON.stringify(body));
        req.end();
    });
}

// 重试(3次指数退避),对齐 skill-scope python 版,应对网关限流
async function httpRequest(url: string, headers: Record<string, string>, body: any): Promise<any> {
    const MAX_RETRY = 3;
    let lastErr: any;
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
        try {
            return await httpRequestOnce(url, headers, body);
        } catch (err) {
            lastErr = err;
            if (attempt < MAX_RETRY) {
                await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
            }
        }
    }
    throw lastErr;
}

async function uploadToObsOnce(url: string, headers: Record<string, string>, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        // 按协议选择模块与端口;保留 query string(OBS 预签名 URL 的签名参数在 query 中)
        const isHttps = urlObj.protocol === 'https:';
        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT),
            path: urlObj.pathname + urlObj.search,
            method: 'PUT',
            // 显式设置 content-length(对齐 py 版),OBS 签名 SignedHeaders 覆盖 content-length
            headers: {...headers, 'content-length': String(data.length)},
            timeout: READ_TIMEOUT
        };

        const req = (isHttps ? https : http).request(options, (res) => {
            if (res.statusCode && res.statusCode >= 400) {
                reject(new Error(`Upload failed: ${res.statusCode}`));
                return;
            }
            resolve();
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Upload timeout'));
        });

        req.write(data);
        req.end();
    });
}

// 重试(3次指数退避),对齐 skill-scope python 版,应对网关限流
async function uploadToObs(url: string, headers: Record<string, string>, data: Buffer): Promise<void> {
    const MAX_RETRY = 3;
    let lastErr: any;
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
        try {
            return await uploadToObsOnce(url, headers, data);
        } catch (err) {
            lastErr = err;
            if (attempt < MAX_RETRY) {
                await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
            }
        }
    }
    throw lastErr;
}

export function loadSkillContent(skillDir: string): string {
    return loadTargetContent(skillDir).content;
}

export function getOriginType(origin: string): string {
    if (origin === 'upload' || origin === 'download' || origin === 'create') {
        return origin;
    }
    if (origin === 'openclaw-bundled' || origin === 'openclaw-workspace') {
        return 'create';
    }
    return 'download';
}

export const DESCRIPTOR_NAMES = ['openclaw.plugin.json', 'plugin.json', 'SKILL.md'];
const PLUGIN_DESCRIPTOR_NAMES = DESCRIPTOR_NAMES.slice(0, 2);

export function loadTargetContent(targetDir: string): { content: string; manifestName: string | null } {
    for (const name of DESCRIPTOR_NAMES) {
        const candidatePath = path.join(targetDir, name);
        try {
            if (fs.existsSync(candidatePath)) {
                return { content: fs.readFileSync(candidatePath, 'utf-8'), manifestName: name };
            }
        } catch (error) {
            const err = error as Error;
            console.warn(`[skill_scope_hook] Failed to read descriptor ${name}: ${err.message}`);
        }
    }
    return { content: '', manifestName: null };
}

export function resolveCallName(manifestName: string | null): string {
    if (manifestName && PLUGIN_DESCRIPTOR_NAMES.includes(manifestName)) {
        return 'install_plugin';
    }
    return 'install_skill';
}

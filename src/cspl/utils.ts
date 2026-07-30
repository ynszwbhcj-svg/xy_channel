/*
 * 版权所有 (c) 华为技术有限公司 2026-2026
 */

import {
    MAX_TEXT_LENGTH,
    regex,
    SECURITY_NOTICE,
    MAX_FILE_COUNT,
    MAX_COMMAND_LENGTH,
    CODE_FILE_EXTENSIONS,
    FILE_EXTENSION_REGEX,
    RESULT_CODE_MAP
} from './constants.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Buffer } from 'buffer';
import { execSync } from 'child_process';
import os from 'os';
import type {OpenClawPluginApi} from "openclaw/plugin-sdk";

import {callApi, CallApiPayload} from './call_api.js';
import { uploadFileToObsMain } from './upload_file.js';
import { logger } from '../utils/logger.js';

// 文本过滤函数：仅保留中文、英文、数字、标点符号
export function filterText(text: string): string {
    if (!text) return "";
    return text.replace(new RegExp(regex.source, 'g'), '');
}

// 文本验证和截断函数
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

    // web_fetch工具特殊处理：从details.text提取
    if (toolName === 'web_fetch') {
        if (event.result?.details?.text) {
            let text = event.result.details.text;
            text = text.replace(SECURITY_NOTICE, '');
            resultTexts.push(text);
        }
        return resultTexts.length > 0 ? resultTexts.join("; ") : "";
    }

    // 白名单工具：从content[].text提取
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
    resultText: string
): string {

    const questionText = filterText(resultText);

    // 检查是否超过4096字符限制，进行截断
    const {text: finalText, truncated} = validateAndTruncateText(questionText, MAX_TEXT_LENGTH);
    if (truncated) {
        logger.warn(`[SENTINEL HOOK] filterText exceeds ${MAX_TEXT_LENGTH}. Original length: ${questionText.length}`);
    }

    return finalText;
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
        throw new Error(`Response.data.securityResult must be "accept" or "reject". Actual value: "${securityResult}"`);
    }

    // 解析 resultCode 并打印错误日志
    const resultCode = response.data?.resultCode;
    if (resultCode !== undefined && resultCode !== null && resultCode !== 0) {
        const errorMsg = RESULT_CODE_MAP[resultCode] || `Unknown error code: ${resultCode}`;
        logger.error(`[SENTINEL HOOK] API returned resultCode=${resultCode}: ${errorMsg}`);
    }

    return {status: securityResult};
}

// 从event对象中提取工具输入参数
export function extractInputParams(event: any, toolName: string): string {
    if (toolName === 'exec') {
        return event.params?.command || '';
    } else if (toolName === 'message') {
        return event.params?.message || '';
    }
    return '';
}

// 从shell命令中提取文件路径
export function extractFilePathsFromCommand(command: string): string[] {
    if (!command) {
        return [];
    }

    // 命令字符串超过1K则截断
    let processedCommand = command;
    if (command.length > MAX_COMMAND_LENGTH) {
        processedCommand = command.substring(0, MAX_COMMAND_LENGTH);
    }

    // 使用空格分割命令字符串
    const parts = processedCommand.split(' ');

    const results: string[] = [];
    let currentBaseDir = '';  // 当前基础目录
    let expectBaseDir = false;  // flag：下一个元素是cd后的基础目录

    // 遍历分割后的命令部分
    for (const part of parts) {
        // 忽略空字符串
        if (!part) {continue; }

        // 处理cd命令后的基础目录
        if (expectBaseDir) {
            currentBaseDir = part;
            expectBaseDir = false;
            continue;
        }

        // 识别cd命令
        if (part === 'cd') {
            expectBaseDir = true;
            continue;
        }

        // 处理代码文件
        const absolutePath = processCodeFile(part, currentBaseDir);
        if (absolutePath && !results.includes(absolutePath)) {
            results.push(absolutePath);
            if (results.length >= MAX_FILE_COUNT) {
                break;
            }
        }
    }

    return results;
}

// 检查是否为代码文件
function isCodeFile(filePath: string): { isCodeFile: boolean; cleanPath: string | null } {
    const lastDotIndex = filePath.lastIndexOf('.');
    if (lastDotIndex === -1) {
        return { isCodeFile: false, cleanPath: null };
    }
    let orign_extension = filePath.substring(lastDotIndex + 1).toLowerCase();
    orign_extension = orign_extension.replace(FILE_EXTENSION_REGEX, ' ');
    const extension = orign_extension.split(' ')[0];
    if (!CODE_FILE_EXTENSIONS.includes(extension)) {
        return { isCodeFile: false, cleanPath: null };
    }
    const cleanPath = `${filePath.substring(0, lastDotIndex + 1)}${extension}`;
    return { isCodeFile: true, cleanPath: cleanPath };
}

// 构建绝对路径
function buildAbsolutePath(filePath: string, baseDir: string): string {
    if (path.isAbsolute(filePath)) {
        return filePath;
    }
    if (baseDir) {
        return `${baseDir}/${filePath}`;
    }
    return filePath;
}

// 处理代码文件，返回绝对路径
function processCodeFile(part: string, currentBaseDir: string): string | null {
    const { isCodeFile: isCodeFileResult, cleanPath } = isCodeFile(part);
    if (!isCodeFileResult) {
        return null;
    }
    return buildAbsolutePath(cleanPath, currentBaseDir);
}

// 计算字符串的SHA256哈希值
export function calculateContentHash(content: string): string {
    if (!content) {
        return '';
    }
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

// 获取文件大小（KB）
export function getFileSizeInKB(filePath: string): number {
    try {
        const stats = fs.statSync(filePath);
        return Math.ceil(stats.size / 1024);
    } catch (error) {
        return 0;
    }
}

// 从taskId中提取sessionID（第一个&之前的内容）
export function extractSessionId(taskId: string): string {
    if (!taskId) return '';
    const idx = taskId.indexOf('&');
    return idx === -1 ? taskId : taskId.substring(0, idx);
}

// 从taskId中提取interActionID（第一个&和第二个&之间的值）
export function extractInterActionId(taskId: string): number {
    if (!taskId) return 1;
    const parts = taskId.split('&');
    if (parts.length >= 2) {
        const id = parseInt(parts[1], 10);
        if (!isNaN(id) && id > 0) return id;
    }
    return 1;
}

// reqTime 生成工具函数
export function formatReqTime(): string {
    const now = new Date();
    const pad = (n: number, len = 2) => String(n).padStart(len, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
           `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${ms}+0800`;
}

// 构建工具输入新消息体（新接口格式）
export function buildToolInputPayload(
    sessionID: string,
    toolName: string,
    toolArguments: string,
    toolCallId: string,
    interActionID: number,
    options?: { file?: { type: string; url: string; hash: string; size: number; body: string } }
): CallApiPayload {
    const callObj: Record<string, any> = {
        type: 'function',
        name: toolName,
        arguments: toolArguments,
        index: 0,
        id: toolCallId
    };
    if (options?.file) {
        callObj.file = [options.file];
    }
    return {
        taskID: crypto.randomUUID(),
        sessionID,
        businessID: 'voiceassistant',
        sceneID: 'XIAOYI_CLAW',
        subSceneID: 'TOOL_INPUT',
        checkPoint: 4,
        interActionID,
        loginType: 'APP',
        reqTime: formatReqTime(),
        message: {
            input: {
                toolIn: [{
                    toolCalls: [callObj]
                }]
            }
        }
    };
}

// 构建工具输出新消息体（新接口格式）
export function buildToolOutputPayload(
    sessionID: string,
    funcName: string,
    content: string,
    toolCallId: string,
    interActionID: number
): CallApiPayload {
    return {
        taskID: crypto.randomUUID(),
        sessionID,
        businessID: 'voiceassistant',
        sceneID: 'XIAOYI_CLAW',
        subSceneID: 'TOOL_OUTPUT',
        checkPoint: 6,
        interActionID,
        loginType: 'APP',
        reqTime: formatReqTime(),
        message: {
            output: {
                toolOut: [{
                    funcName,
                    content: [{
                        type: 'text',
                        rawText: content
                    }],
                    toolCallId
                }]
            }
        }
    };
}

// 发送新接口请求并处理响应，返回扫描结果（保留block/steer能力）
async function sendToolInputRequest(payload: CallApiPayload, api: OpenClawPluginApi, sessionId: string, toolCallId: string): Promise<{ status: 'ACCEPT' | 'REJECT' }> {
    const response = await callApi(payload, api, sessionId);
    const result = parseSecurityResult(response);
    logger.log(`[SENTINEL HOOK] toolCallId=${toolCallId}, TOOL_INPUT response: status=${result.status}`);
    return result;
}

// 处理exec工具的TOOL_INPUT数据采集，返回扫描结果（保留block/steer能力）
export async function handleExecToolInput(event: any, api: OpenClawPluginApi, sessionId: string, taskId: string): Promise<{ status: 'ACCEPT' | 'REJECT' } | null> {
    const command = extractInputParams(event, 'exec');
    if (!command) {
        logger.log('[SENTINEL HOOK] No command found for exec tool');
        return null;
    }

    const interActionID = extractInterActionId(taskId);

    // 解析命令提取文件路径
    const filePaths = extractFilePathsFromCommand(command);

    if (filePaths.length > 0) {
        // 场景1：执行代码文件
        logger.log(`[SENTINEL HOOK] Found ${filePaths.length} file(s) in command`);

        const nonExistingFiles: string[] = [];
        let lastResult: { status: 'ACCEPT' | 'REJECT' } | null = null;

        for (const filePath of filePaths) {
            if (!fs.existsSync(filePath)) {
                nonExistingFiles.push(filePath);
                continue;
            }
            const fileContent = fs.readFileSync(filePath, 'utf8');
            const fileHash = calculateContentHash(fileContent);
            const fileSize = getFileSizeInKB(filePath);

            const obsUrl = await uploadFileToObsMain(filePath, api, fileHash, sessionId);

            // 截断 body 到 MAX_TEXT_LENGTH
            let bodyContent = fileContent;
            if (Buffer.byteLength(bodyContent, 'utf8') > MAX_TEXT_LENGTH) {
                bodyContent = bodyContent.substring(0, MAX_TEXT_LENGTH);
                logger.warn(`[SENTINEL HOOK] File content truncated to ${MAX_TEXT_LENGTH} characters`);
            }

            const toolInputPayload = buildToolInputPayload(
                sessionId,
                'exec',
                command,
                event.toolCallId,
                interActionID,
                { file: { type: 'doc', url: obsUrl, hash: fileHash, size: fileSize, body: bodyContent } }
            );

            logger.log(`[SENTINEL HOOK] Sending TOOL_INPUT for file: ${path.basename(filePath)}, body length: ${JSON.stringify(toolInputPayload).length}`);
            try {
                lastResult = await sendToolInputRequest(toolInputPayload, api, sessionId, event.toolCallId);
                if (lastResult.status === 'REJECT') {
                    return lastResult;
                }
            } catch (e) {
                logger.error(`[SENTINEL HOOK] Sending TOOL_INPUT Failed: ${e}`);
            }
        }

        // 输出不存在的文件列表
        if (nonExistingFiles.length > 0) {
            const fileNames = nonExistingFiles.map(f => path.basename(f)).join(', ');
            logger.log(`[SENTINEL HOOK] Non-existing files: ${fileNames}`);
        }

        return lastResult;
    } else {
        // 场景2：直接执行代码（heredoc场景）
        logger.log('[SENTINEL HOOK] No code files found in command, treating as direct code execution');

        const toolInputPayload = buildToolInputPayload(
            sessionId,
            'exec',
            command,
            event.toolCallId,
            interActionID
        );
        logger.log(`[SENTINEL HOOK] Sending TOOL_INPUT for direct code execution, body length: ${JSON.stringify(toolInputPayload).length}`);

        return await sendToolInputRequest(toolInputPayload, api, sessionId, event.toolCallId);
    }
}

// 处理message工具的TOOL_INPUT数据采集，返回扫描结果（保留block/steer能力）
export async function handleMessageToolInput(event: any, api: OpenClawPluginApi, sessionId: string, taskId: string): Promise<{ status: 'ACCEPT' | 'REJECT' } | null> {
    const message = extractInputParams(event, 'message');
    if (!message) {
        logger.log('[SENTINEL HOOK] No message found for message tool');
        return null;
    }

    logger.log(`[SENTINEL HOOK] Processing message tool input, message length: ${message.length}`);

    const interActionID = extractInterActionId(taskId);

    const toolInputPayload = buildToolInputPayload(
        sessionId,
        'message',
        message,
        event.toolCallId,
        interActionID
    );

    logger.log(`[SENTINEL HOOK] Sending TOOL_INPUT for message, body length: ${JSON.stringify(toolInputPayload).length}`);

    return await sendToolInputRequest(toolInputPayload, api, sessionId, event.toolCallId);
}

// 计算项目目录的哈希值（遍历所有文件）
export function calculateProjectHash(sourcePath: string): string {
    const hash = crypto.createHash('sha256');
    try {
        const files = walkDirSync(sourcePath);
        for (const file of files.sort()) {
            const content = fs.readFileSync(file, 'utf8');
            hash.update(file);
            hash.update(content);
        }
    } catch {
        // 如果是单文件，直接计算文件哈希
        if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile()) {
            const content = fs.readFileSync(sourcePath, 'utf8');
            hash.update(content);
        }
    }
    return hash.digest('hex');
}

// 递归遍历目录获取所有文件路径
function walkDirSync(dir: string): string[] {
    const results: string[] = [];
    try {
        const list = fs.readdirSync(dir);
        for (const file of list) {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                results.push(...walkDirSync(fullPath));
            } else {
                results.push(fullPath);
            }
        }
    } catch {
        // ignore
    }
    return results;
}

// 创建zip并上传到OBS，返回下载URL
export async function createAndUploadZip(
    sourcePath: string,
    apiConfig: { apiKey: string; uid: string; serviceUrl: string },
    api: OpenClawPluginApi
): Promise<string> {
    const tmpDir = os.tmpdir();
    const zipName = `skill_${Date.now()}.zip`;
    const zipPath = path.join(tmpDir, zipName);

    try {
        // 创建zip包
        const parentDir = path.dirname(sourcePath);
        const baseName = path.basename(sourcePath);
        execSync(`cd "${parentDir}" && zip -r "${zipPath}" "${baseName}"`, { encoding: 'utf8' });

        const fileHash = calculateContentHash(fs.readFileSync(zipPath, 'utf8'));
        const downloadUrl = await uploadFileToObsMain(zipPath, api, fileHash, crypto.randomBytes(16).toString('hex'));
        return downloadUrl;
    } finally {
        // 清理临时文件
        try {
            if (fs.existsSync(zipPath)) {
                fs.unlinkSync(zipPath);
            }
        } catch {
            // ignore cleanup errors
        }
    }
}

// 根据origin判断skill类型
export function getOriginType(origin: string): string {
    if (!origin) return 'create';
    if (origin.includes('download')) return 'download';
    if (origin.includes('upload')) return 'upload';
    return 'create';
}

// 加载skill内容（从SKILL.md或目录中的主要文件）
export function loadSkillContent(sourcePath: string): string {
    try {
        // 如果是目录，尝试读取SKILL.md
        if (fs.statSync(sourcePath).isDirectory()) {
            const skillMdPath = path.join(sourcePath, 'SKILL.md');
            if (fs.existsSync(skillMdPath)) {
                return fs.readFileSync(skillMdPath, 'utf8');
            }
            // 尝试读取目录下第一个md文件
            const files = fs.readdirSync(sourcePath);
            for (const file of files) {
                if (file.endsWith('.md')) {
                    return fs.readFileSync(path.join(sourcePath, file), 'utf8');
                }
            }
            return '';
        }
        // 单文件直接读取
        return fs.readFileSync(sourcePath, 'utf8');
    } catch {
        return '';
    }
}

// 处理其他工具（非 exec 和非 message）的 TOOL_INPUT 数据采集，返回扫描结果（保留block/steer能力）
export async function handleOtherToolInput(event: any, api: OpenClawPluginApi, sessionId: string, taskId: string): Promise<{ status: 'ACCEPT' | 'REJECT' } | null> {
    const params = event.params;
    if (!params) {
        logger.log('[SENTINEL HOOK] No params found for tool');
        return null;
    }

    logger.log(`[SENTINEL HOOK] Processing other tool input, toolName: ${event.toolName}`);

    // 将 params 序列化为 JSON 字符串，并限制长度
    const paramsJson = JSON.stringify(params).substring(0, MAX_TEXT_LENGTH);

    const interActionID = extractInterActionId(taskId);

    const toolInputPayload = buildToolInputPayload(
        sessionId,
        event.toolName,
        paramsJson,
        event.toolCallId,
        interActionID
    );

    logger.log(`[SENTINEL HOOK] Sending TOOL_INPUT for ${event.toolName}, body length: ${JSON.stringify(toolInputPayload).length}`);

    return await sendToolInputRequest(toolInputPayload, api, sessionId, event.toolCallId);
}

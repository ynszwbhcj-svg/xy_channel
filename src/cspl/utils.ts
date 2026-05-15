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
    TOOL_INPUT_DEFAULT,
    FILE_EXTENSION_REGEX
} from './constants.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Buffer } from 'buffer';
import type {OpenClawPluginApi} from "openclaw/plugin-sdk";

import {callApi} from './call_api.js';
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
    resultText: string,
    api: OpenClawPluginApi
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
        throw new Error(`Response.data.securityResult must be "ACCEPT" or "REJECT". Actual value: "${securityResult}"`);
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

// 动态计算content字段长度，确保body总长度<=4096
export function adjustContentLength(data: any, api: OpenClawPluginApi, fields: string[]): any {
    const adjusted = {...data};
    let bodyStr = JSON.stringify(adjusted);
    if (bodyStr.length <= MAX_TEXT_LENGTH) {
        return adjusted;
    }
    // 需要截断指定字段
    let lastFieldName = '';
    for (const fieldName of fields) {
        lastFieldName = fieldName;

        bodyStr = JSON.stringify(adjusted);
        const overSize = bodyStr.length - MAX_TEXT_LENGTH;
        const currentFieldValue = adjusted[fieldName];
        if (currentFieldValue && typeof currentFieldValue === 'string' && currentFieldValue.length > overSize) {
            // 从字段头部开始截断
            adjusted[fieldName] = currentFieldValue.substring(0, currentFieldValue.length - overSize);
            logger.warn(`[SENTINEL HOOK] Field "${fieldName}" truncated by ${overSize} characters to fit ${MAX_TEXT_LENGTH} limit`);
        } else {
            // 字段太短，清空字段
            adjusted[fieldName] = '';
            logger.warn(`[SENTINEL HOOK] Field "${fieldName}" cleared as it cannot fit within size limit`);
        }
        // 检查是否满足要求
        bodyStr = JSON.stringify(adjusted);
        if (bodyStr.length <= MAX_TEXT_LENGTH) {
            break;
        }
    }
    bodyStr = JSON.stringify(adjusted);
    if (bodyStr.length > MAX_TEXT_LENGTH) {
        throw new Error(`Field ${lastFieldName} exceeds length limit, unable to send data.`);
    }

    return adjusted;
}

// 发送TOOL_INPUT请求并处理响应
async function sendToolInputRequest(postText: string, api: OpenClawPluginApi, sessionId: string): Promise<void> {
    const response = await callApi(postText, api, sessionId);
    const result = parseSecurityResult(response);
    logger.log(`[SENTINEL HOOK] TOOL_INPUT response: status=${result.status}`);
}

// 处理exec工具的TOOL_INPUT数据采集
export async function handleExecToolInput(event: any, api: OpenClawPluginApi, sessionId: string): Promise<string | null> {
    const command = extractInputParams(event, 'exec');
    if (!command) {
        logger.log('[SENTINEL HOOK] No command found for exec tool');
        return null;
    }

    // 解析命令提取文件路径
    const filePaths = extractFilePathsFromCommand(command);

    if (filePaths.length > 0) {
        // 场景1：执行代码文件
        logger.log(`[SENTINEL HOOK] Found ${filePaths.length} file(s) in command`);

        const nonExistingFiles: string[] = [];

        for (const filePath of filePaths) {
            if (!fs.existsSync(filePath)) {
                nonExistingFiles.push(filePath);
                continue;
            }
            const fileContent = fs.readFileSync(filePath, 'utf8');
            const fileHash = calculateContentHash(fileContent);
            const fileSize = getFileSizeInKB(filePath);

            const obsUrl = await uploadFileToObsMain(filePath, api, fileHash, sessionId);
            const toolInputData = {...TOOL_INPUT_DEFAULT, tool: 'exec', hash: fileHash, url: obsUrl, size: fileSize,
                source: command, content: fileContent};

            const adjustedData = adjustContentLength(toolInputData, api, ['content', 'source']);
            const postText = JSON.stringify(adjustedData);

            logger.log(`[SENTINEL HOOK] Sending TOOL_INPUT for file: ${path.basename(filePath)}, body length: ${postText.length}`);
            try {
                await sendToolInputRequest(postText, api, sessionId);
            }catch (e) {
                logger.error(`[SENTINEL HOOK] Sending TOOL_INPUT Failed: ${e}`);
            }

        }

        // 输出不存在的文件列表
        if (nonExistingFiles.length > 0) {
            const fileNames = nonExistingFiles.map(f => path.basename(f)).join(', ');
            logger.log(`[SENTINEL HOOK] Non-existing files: ${fileNames}`);
        }
    } else {
        // 场景2：直接执行代码（heredoc场景）
        logger.log('[SENTINEL HOOK] No code files found in command, treating as direct code execution');

        const commandHash = calculateContentHash(command);
        const commandSizeKB = Math.ceil(Buffer.byteLength(command, 'utf8') / 1024);

        const toolInputData = {...TOOL_INPUT_DEFAULT, tool: 'exec', hash: commandHash, size: commandSizeKB, source: command};
        const adjustedData = adjustContentLength(toolInputData, api, ['source']);

        const postText = JSON.stringify(adjustedData);
        logger.log(`[SENTINEL HOOK] Sending TOOL_INPUT for direct code execution, body length: ${postText.length}`);

        await sendToolInputRequest(postText, api, sessionId);
    }
}

// 处理message工具的TOOL_INPUT数据采集
export async function handleMessageToolInput(event: any, api: OpenClawPluginApi, sessionId: string): Promise<string | null> {
    const message = extractInputParams(event, 'message');
    if (!message) {
        logger.log('[SENTINEL HOOK] No message found for message tool');
        return null;
    }

    logger.log(`[SENTINEL HOOK] Processing message tool input, message length: ${message.length}`);

    const messageHash = calculateContentHash(message);
    const messageSizeKB = Math.ceil(Buffer.byteLength(message, 'utf8') / 1024);

    const toolInputData = {...TOOL_INPUT_DEFAULT, tool: 'message', hash: messageHash, size: messageSizeKB, content: message};

    const adjustedData = adjustContentLength(toolInputData, api, ['content']);
    const postText = JSON.stringify(adjustedData);

    logger.log(`[SENTINEL HOOK] Sending TOOL_INPUT for message, body length: ${postText.length}`);

    await sendToolInputRequest(postText, api, sessionId);
}

// 处理其他工具（非 exec 和非 message）的 TOOL_INPUT 数据采集
export async function handleOtherToolInput(event: any, api: OpenClawPluginApi, sessionId: string): Promise<void> {
    const params = event.params;
    if (!params) {
        logger.log('[SENTINEL HOOK] No params found for tool');
        return;
    }

    logger.log(`[SENTINEL HOOK] Processing other tool input, toolName: ${event.toolName}`);

    // 将 params 序列化为 JSON 字符串
    const paramsJson = JSON.stringify(params);
    const paramsHash = calculateContentHash(paramsJson);
    const paramsSizeKB = Math.ceil(Buffer.byteLength(paramsJson, 'utf8') / 1024);

    // 创建 toolInputData，将 params 放到 source 字段
    const toolInputData = {...TOOL_INPUT_DEFAULT, tool: event.toolName, hash: paramsHash, size: paramsSizeKB, content: paramsJson};

    // 对 source 字段进行长度截断处理
    const adjustedData = adjustContentLength(toolInputData, api, ['content']);
    const postText = JSON.stringify(adjustedData);

    logger.log(`[SENTINEL HOOK] Sending TOOL_INPUT for ${event.toolName}, body length: ${postText.length}`);

    await sendToolInputRequest(postText, api, sessionId);
}
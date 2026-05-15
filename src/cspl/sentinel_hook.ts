/*
 * 版权所有 (c) 华为技术有限公司 2026-2026
 */

import crypto from 'crypto';
import type {OpenClawPluginApi} from "openclaw/plugin-sdk";

import {callApi} from './call_api.js';
import {
    processText,
    extractResultText,
    validateAndTruncateText,
    parseSecurityResult,
    handleExecToolInput,
    handleMessageToolInput,
    handleOtherToolInput
} from './utils.js';
import {
    ALLOWED_TOOLS,
    MAX_TEXT_LENGTH,
    MAX_TOTAL_LENGTH,
    MIN_TEXT_LENGTH
} from './constants.js';
import { logger } from '../utils/logger.js';

// 主入口模块
export default function register(api: OpenClawPluginApi) {
    api.on("before_tool_call", async (event, ctx) => {
        logger.log(`[SENTINEL HOOK] before_tool_call_event toolName: ${event.toolName}`);
        // 生成sessionID
        const sessionId = (event.runId?.replace(/-/g, '') || crypto.randomBytes(16).toString('hex'));
        logger.log(`[SENTINEL HOOK] Generated Session ID: ${sessionId}`);
        // 处理 TOOL_INPUT 数据采集、发送数据
        try {
            if (event.toolName === 'exec') {
                await handleExecToolInput(event, api, sessionId);
            } else if (event.toolName === 'message') {
                await handleMessageToolInput(event, api, sessionId);
            } else {
                await handleOtherToolInput(event, api, sessionId);
            }
        }catch (error) {
            logger.error(`[SENTINEL HOOK] Extracted TOOL_INPUT data processing exception: ${error}`);
        }
    });
    api.on("after_tool_call", async (event, ctx) => {
        // 检查是否在输出白名单中
        if (!ALLOWED_TOOLS.includes(event.toolName)) {
            return;
        }
        try {
            logger.log(`[SENTINEL HOOK] after_tool_call_event toolName: ${event.toolName}`);
            // 生成sessionID
            const sessionId = (event.runId?.replace(/-/g, '') || crypto.randomBytes(16).toString('hex'));
            logger.log(`[SENTINEL HOOK] Generated Session ID: ${sessionId}`);

            // 处理TOOL_OUTPUT数据采集（保持现有逻辑）
            const resultText = extractResultText(event, event.toolName);
            const resultTextLength = resultText.length;

            if (resultTextLength > MAX_TOTAL_LENGTH) {
                logger.warn(
                    `[SENTINEL HOOK] Text exceeds ${MAX_TOTAL_LENGTH} character limit. Actual length: ${resultTextLength}`);
                return;
            }

            if (resultTextLength <= MIN_TEXT_LENGTH) {
                logger.log("[SENTINEL HOOK] No valid information at collection point");
                return;
            }

            // 处理和验证文本
            const questionText = {subSceneID: 'TOOL_OUTPUT',tool: `${event.toolName}`,output: [{content: ""}]};

            const originText = processText(resultText, api);
            questionText.output[0].content = `${originText}`;
            const finalText = JSON.stringify(questionText);
            if (finalText.length > MAX_TEXT_LENGTH) {
                const diff_length = finalText.length - MAX_TEXT_LENGTH;
                const {
                    text: filterText,
                    truncated
                } = validateAndTruncateText(originText, MAX_TEXT_LENGTH - diff_length);
                if (truncated) {
                    questionText.output[0].content = `${filterText}`;
                    logger.warn(`[SENTINEL HOOK] postText exceeds ${MAX_TEXT_LENGTH}.`);
                }
            }
            const postText = JSON.stringify(questionText);

            logger.log(`[SENTINEL HOOK] Content extracted successfully. Length: ${postText.length}`);

            try {
                const response = await callApi(postText, api, sessionId);

                const result = parseSecurityResult(response);
                logger.log(`[SENTINEL HOOK] TOOL_OUTPUT response: status=${result.status}.`);
                if (result.status === 'REJECT') {
                    logger.warn('[SENTINEL HOOK] Interrupt handler');
                }
            } catch (error) {
                throw new Error(`[SENTINEL HOOK] API call failed: ${error}`);
            }
        } catch (error) {
            logger.error(`[SENTINEL HOOK] Extracted TOOL_OUTPUT data processing exception: ${error}`);
        }
    });
}
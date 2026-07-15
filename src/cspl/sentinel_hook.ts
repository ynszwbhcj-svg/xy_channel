/*
 * 版权所有 (c) 华为技术有限公司 2026-2026
 */

import crypto from 'crypto';
import type {OpenClawPluginApi} from "openclaw/plugin-sdk";

import { logger } from '../utils/logger.js';
import {callApi} from './call_api.js';
import {
    processText,
    extractResultText,
    validateAndTruncateText,
    parseSecurityResult,
    handleExecToolInput,
    handleMessageToolInput,
    handleOtherToolInput,
    buildToolOutputPayload,
    extractInterActionId,
    extractSessionId
} from './utils.js';
import {
    ALLOWED_TOOLS,
    MAX_TOTAL_LENGTH,
    MIN_TEXT_LENGTH,
    MAX_TEXT_LENGTH,
    STEER_ABORT_MESSAGE
} from './constants.js';
import { getCurrentSessionContext } from '../tools/session-manager.js';
import { tryInjectSteer } from './steer-context.js';

// 主入口模块
export default function register(api: OpenClawPluginApi) {
    api.on("before_tool_call", async (event, _ctx) => {
        logger.log(`[SENTINEL HOOK] before_tool_call_event toolName: ${event.toolName}`);
        // 获取真实sessionID：优先使用ALS中的A2A sessionId，降级到OpenClaw runId或随机值
        const sessionCtx = getCurrentSessionContext();
        const sessionId = sessionCtx?.sessionId || (event.runId?.replace(/-/g, '') || crypto.randomBytes(16).toString('hex'));
        const taskId = sessionCtx?.taskId || event.runId;
        logger.log(`[SENTINEL HOOK] Session ID: ${sessionId}, Task ID: ${taskId} (fromALS: ${!!sessionCtx?.sessionId})`);
        // 请求体中的sessionID从taskId中提取（第一个&之前的内容）
        const payloadSessionId = extractSessionId(taskId) || sessionId;
        // 处理 TOOL_INPUT 数据采集、发送数据，根据扫描结果决定是否阻塞
        try {
            let scanResult: { status: 'ACCEPT' | 'REJECT' } | null = null;
            if (event.toolName === 'exec') {
                scanResult = await handleExecToolInput(event, api, payloadSessionId, taskId);
            } else if (event.toolName === 'message') {
                scanResult = await handleMessageToolInput(event, api, payloadSessionId, taskId);
            } else {
                scanResult = await handleOtherToolInput(event, api, payloadSessionId, taskId);
            }
            if (scanResult?.status === 'REJECT') {
                logger.warn(`[SENTINEL HOOK] TOOL_INPUT REJECT, blocking tool call: ${event.toolName}`);
                return { block: true, blockReason: `安全扫描检测到风险，已阻止工具调用: ${event.toolName}` };
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
            // 获取真实sessionID：优先使用ALS中的A2A sessionId，降级到OpenClaw runId或随机值
            const sessionCtx = getCurrentSessionContext();
            const sessionId = sessionCtx?.sessionId || (event.runId?.replace(/-/g, '') || crypto.randomBytes(16).toString('hex'));
            const taskId = sessionCtx?.taskId || event.runId;
            logger.log(`[SENTINEL HOOK] Session ID: ${sessionId}, Task ID: ${taskId} (fromALS: ${!!sessionCtx?.sessionId})`);
            // 请求体中的sessionID从taskId中提取（第一个&之前的内容）
            const payloadSessionId = extractSessionId(taskId) || sessionId;

            // 处理TOOL_OUTPUT数据采集
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
            const originText = processText(resultText);
            let content = originText;
            if (originText.length > MAX_TEXT_LENGTH) {
                const {
                    text: filterText,
                    truncated
                } = validateAndTruncateText(originText, MAX_TEXT_LENGTH);
                if (truncated) {
                    content = filterText;
                    logger.warn(`[SENTINEL HOOK] postText exceeds ${MAX_TEXT_LENGTH}.`);
                }
            }

            const interActionID = extractInterActionId(taskId);
            const outputPayload = buildToolOutputPayload(
                taskId,
                payloadSessionId,
                event.toolName,
                content,
                event.toolCallId,
                interActionID
            );

            logger.log(`[SENTINEL HOOK] Content extracted successfully. Length: ${JSON.stringify(outputPayload).length}`);

            try {
                const response = await callApi(outputPayload, api, sessionId);

                const result = parseSecurityResult(response);
                logger.log(`[SENTINEL HOOK] TOOL_OUTPUT response: status=${result.status}.`);
                if (result.status === 'REJECT') {
                    logger.warn('[SENTINEL HOOK] REJECT detected, attempting steer injection');
                    if (sessionCtx?.sessionId && sessionCtx?.taskId) {
                        await tryInjectSteer({
                            sessionId: sessionCtx.sessionId,
                            taskId: sessionCtx.taskId,
                            message: STEER_ABORT_MESSAGE,
                            source: 'cspl',
                        });
                    } else {
                        logger.warn(`[SENTINEL HOOK] Cannot inject steer: sessionKey=${ctx.sessionKey}, sessionCtx found=${!!sessionCtx}`);
                    }
                }
            } catch (error) {
                throw new Error(`[SENTINEL HOOK] API call failed: ${error}`);
            }
        } catch (error) {
            logger.error(`[SENTINEL HOOK] Extracted TOOL_OUTPUT data processing exception: ${error}`);
        }
    });
}

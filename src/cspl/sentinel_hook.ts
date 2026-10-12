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
import { steer } from '../conversation/steer-service.js';

// 主入口模块
export default function register(api: OpenClawPluginApi) {
    /**
     * 从钩子 ctx.sessionKey 解析 A2A sessionId。
     * xiaoyi-channel 的 sessionKey 形如 agent:<agentId>:...:<sessionId>，
     * 最后一个 `:` 分隔段即 A2A sessionId（与 channel.ts 的
     * resolveCommandConversation 同一约定）。事件参数是 openclaw 传给钩子的
     * ground truth，不像 ALS 会受并发 session 的异步树串扰污染。
     */
    const sessionIdFromSessionKey = (sessionKey?: string): string | undefined => {
        if (!sessionKey) return undefined;
        const lastColon = sessionKey.lastIndexOf(":");
        if (lastColon < 0) return undefined;
        const id = sessionKey.slice(lastColon + 1).trim();
        return id || undefined;
    };

    /**
     * 解析本次工具调用的归属：优先事件 ctx.sessionKey（ground truth），
     * ALS 仅在「与事件归属一致」或「事件无 sessionKey」时才采信，
     * 避免污染窗口内把扫描报告挂到别的任务上。
     */
    const resolveAttribution = (event: any, ctx: any) => {
        const eventSessionId = sessionIdFromSessionKey(ctx?.sessionKey);
        const sessionCtx = getCurrentSessionContext();
        const alsConsistent = !!sessionCtx?.sessionId && (!eventSessionId || sessionCtx.sessionId === eventSessionId);
        const sessionId = eventSessionId || sessionCtx?.sessionId || event.runId || crypto.randomBytes(16).toString('hex');
        // ALS 被污染时其 taskId 属于别的 session，不可采信，降级到 runId
        const taskId = (alsConsistent ? sessionCtx.taskId : undefined) || event.runId;
        return { sessionId, taskId, sessionCtx: alsConsistent ? sessionCtx : null, eventSessionId };
    };

    api.on("before_tool_call", async (event, ctx) => {
        logger.log(`[SENTINEL HOOK] toolCallId=${event.toolCallId}, before_tool_call_event toolName: ${event.toolName}`);
        // 归属解析：优先事件 ctx.sessionKey，ALS 仅在与事件一致时采信
        const { sessionId, taskId, eventSessionId } = resolveAttribution(event, ctx);
        logger.log(`[SENTINEL HOOK] Session ID: ${sessionId}, Task ID: ${taskId} (fromEvent: ${!!eventSessionId})`);
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
            logger.log(`[SENTINEL HOOK] toolCallId=${event.toolCallId}, after_tool_call_event toolName: ${event.toolName}`);
            // 归属解析：优先事件 ctx.sessionKey，ALS 仅在与事件一致时采信
            const { sessionId, taskId, sessionCtx, eventSessionId } = resolveAttribution(event, ctx);
            logger.log(`[SENTINEL HOOK] Session ID: ${sessionId}, Task ID: ${taskId} (fromEvent: ${!!eventSessionId})`);
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
                logger.log(`[SENTINEL HOOK] toolCallId=${event.toolCallId}, TOOL_OUTPUT response: status=${result.status}.`);
                if (result.status === 'REJECT') {
                    logger.warn('[SENTINEL HOOK] REJECT detected, attempting steer injection');
                    // steer 目标优先取事件归属（ground truth），其次才是与事件一致的 ALS，
                    // 避免污染窗口内向错误的 session 注入 steer
                    const steerTarget = eventSessionId || sessionCtx?.sessionId;
                    if (steerTarget) {
                        // CSPL steer：经对话管理层直接 steer 当前会话；
                        // 注入失败即失败，仅记录日志，不做兜底（不新建 dispatcher）
                        await steer(steerTarget, STEER_ABORT_MESSAGE, 'cspl');
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

// OpenClaw to A2A format conversion
import { v4 as uuidv4 } from "uuid";
import { getXYWebSocketManager } from "./client.js";
import { getXYRuntime } from "./runtime.js";
import { redactSensitiveText, containsSensitiveInfo } from "./sensitive-redactor.js";
import { rewriteOutboundApprovalText } from "./approval-bridge.js";

const MESSAGE_CONTENT_KEYS = new Set(["text", "reasoningText", "content", "message"]);

function redactMessagePayload(value, currentKey) {
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value === "string") {
        if (currentKey === undefined || MESSAGE_CONTENT_KEYS.has(currentKey)) {
            return redactSensitiveText(value);
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(item => redactMessagePayload(item, currentKey));
    }
    if (typeof value === "object") {
        const result = {};
        for (const key of Object.keys(value)) {
            result[key] = redactMessagePayload(value[key], key);
        }
        return result;
    }
    return value;
}

function buildTextPreview(text) {
    if (typeof text !== "string" || text.length === 0) {
        return "";
    }
    return text.length <= 10 ? text : `${text.slice(0, 5)}***${text.slice(-5)}`;
}

/**
 * Send an A2A artifact update response.
 */
export async function sendA2AResponse(params) {
    const { config, sessionId, taskId, messageId, text, append, final, files } = params;
    const runtime = getXYRuntime();
    const log = runtime?.log ?? console.log;
    const error = runtime?.error ?? console.error;

    // 在真正下发到 Xiaoyi 前，先把 OpenClaw 的审批提示翻译成自然语言确认文案。
    const bridgedText = text === undefined ? text : rewriteOutboundApprovalText(sessionId, text);
    const redactedText = redactSensitiveText(bridgedText);

    // 先构造 A2A 的 artifact-update 基础结构，后面再逐步填充 parts。
    const artifact = {
        taskId,
        kind: "artifact-update",
        append,
        lastChunk: true,
        final,
        artifact: {
            artifactId: uuidv4(),
            parts: [],
        },
    };

    // 如果有文本内容，先挂到 text part 里，后面统一做扫描脱敏。
    if (bridgedText !== undefined) {
        artifact.artifact.parts.push({
            kind: "text",
            text: bridgedText,
        });
    }

    // 文件信息作为 data part 下发，供客户端渲染或下载。
    if (files && files.length > 0) {
        artifact.artifact.parts.push({
            kind: "data",
            data: { fileInfo: files },
        });
    }

    // 这里只对消息内容字段做脱敏，不修改协议层的 id 等字段。
    artifact.artifact.parts = redactMessagePayload(artifact.artifact.parts, "parts");

    // 再包一层 JSON-RPC 响应结构，符合 A2A 下发格式。
    const jsonRpcResponse = {
        jsonrpc: "2.0",
        id: messageId,
        result: artifact,
    };

    // 获取当前 WebSocket 管理器，并把序列化后的消息发出去。
    const wsManager = getXYWebSocketManager(config);
    const outboundMessage = {
        msgType: "agent_response",
        agentId: config.agentId,
        sessionId,
        taskId,
        msgDetail: JSON.stringify(jsonRpcResponse),
    };

    log(`[A2A_RESPONSE] Sending A2A artifact-update response: taskId: ${taskId}`);
    log(`[A2A_RESPONSE]   - append: ${append}`);
    log(`[A2A_RESPONSE]   - final: ${final}`);
    log(`[A2A_RESPONSE]   - text: ${buildTextPreview(redactedText)}`);
    log(`[A2A_RESPONSE]   - files count: ${files?.length ?? 0}`);
    log(`[A2A_RESPONSE]   - sensitive info detected: ${containsSensitiveInfo(bridgedText)}`);

    await wsManager.sendMessage(sessionId, outboundMessage);
    log(`[A2A_RESPONSE] Message sent successfully`);
}

/**
 * Send an A2A artifact-update with reasoningText part.
 * Used for onToolStart, onToolResult, onReasoningStream, onReasoningEnd, onPartialReply.
 * append=true, final=false, lastChunk=true.
 */
export async function sendReasoningTextUpdate(params) {
    const { config, sessionId, taskId, messageId, text, append = true } = params;
    const runtime = getXYRuntime();
    const log = runtime?.log ?? console.log;
    const error = runtime?.error ?? console.error;
    const bridgedText = rewriteOutboundApprovalText(sessionId, text);

    const artifact = {
        taskId,
        kind: "artifact-update",
        append,
        lastChunk: true,
        final: false,
        artifact: {
            artifactId: uuidv4(),
            parts: [
                {
                    kind: "reasoningText",
                    reasoningText: bridgedText,
                },
            ],
        },
    };

    artifact.artifact.parts = redactMessagePayload(artifact.artifact.parts, "parts");

    const jsonRpcResponse = {
        jsonrpc: "2.0",
        id: messageId,
        result: artifact,
    };

    const wsManager = getXYWebSocketManager(config);
    const outboundMessage = {
        msgType: "agent_response",
        agentId: config.agentId,
        sessionId,
        taskId,
        msgDetail: JSON.stringify(jsonRpcResponse),
    };

    await wsManager.sendMessage(sessionId, outboundMessage);
}

/**
 * Send an A2A task status update.
 * Follows A2A protocol standard format with nested status object.
 */
export async function sendStatusUpdate(params) {
    const { config, sessionId, taskId, messageId, text, state } = params;
    const runtime = getXYRuntime();
    const log = runtime?.log ?? console.log;
    const error = runtime?.error ?? console.error;

    const bridgedText = rewriteOutboundApprovalText(sessionId, text);
    const redactedText = redactSensitiveText(bridgedText);

    const statusMessage = redactMessagePayload({
        role: "agent",
        parts: [
            {
                kind: "text",
                text: bridgedText,
            },
        ],
    });

    const statusUpdate = {
        taskId,
        kind: "status-update",
        final: false,
        status: {
            message: statusMessage,
            state,
        },
    };

    const jsonRpcResponse = {
        jsonrpc: "2.0",
        id: messageId,
        result: statusUpdate,
    };

    const wsManager = getXYWebSocketManager(config);
    const outboundMessage = {
        msgType: "agent_response",
        agentId: config.agentId,
        sessionId,
        taskId,
        msgDetail: JSON.stringify(jsonRpcResponse),
    };

    log(`[A2A_STATUS] Sending A2A status-update:`);
    log(`[A2A_STATUS]   - taskId: ${taskId}`);
    log(`[A2A_STATUS]   - text: "${redactedText}"`);

    await wsManager.sendMessage(sessionId, outboundMessage);
}

/**
 * Send a command as an artifact update (final=false).
 */
export async function sendCommand(params) {
    const { config, sessionId, taskId, messageId, command } = params;
    const runtime = getXYRuntime();
    const log = runtime?.log ?? console.log;
    const error = runtime?.error ?? console.error;

    const artifact = {
        taskId,
        kind: "artifact-update",
        append: false,
        lastChunk: true,
        final: false,
        artifact: {
            artifactId: uuidv4(),
            parts: [
                {
                    kind: "data",
                    data: {
                        commands: [command],
                    },
                },
            ],
        },
    };

    artifact.artifact.parts = redactMessagePayload(artifact.artifact.parts, "parts");

    const jsonRpcResponse = {
        jsonrpc: "2.0",
        id: messageId,
        result: artifact,
    };

    const wsManager = getXYWebSocketManager(config);
    const outboundMessage = {
        msgType: "agent_response",
        agentId: config.agentId,
        sessionId,
        taskId,
        msgDetail: JSON.stringify(jsonRpcResponse),
    };

    log(`[A2A_COMMAND] Sending A2A command: taskId: ${taskId}`);
    await wsManager.sendMessage(sessionId, outboundMessage);
    log(`[A2A_COMMAND] Command sent successfully`);
}

/**
 * Send a clearContext response.
 */
export async function sendClearContextResponse(params) {
    const { config, sessionId, messageId } = params;
    const runtime = getXYRuntime();
    const log = runtime?.log ?? console.log;
    const error = runtime?.error ?? console.error;

    const jsonRpcResponse = {
        jsonrpc: "2.0",
        id: messageId,
        result: {
            status: {
                state: "cleared",
            },
        },
        error: {
            code: 0,
            message: "",
        },
    };

    const wsManager = getXYWebSocketManager(config);
    const outboundMessage = {
        msgType: "agent_response",
        agentId: config.agentId,
        sessionId,
        taskId: sessionId,
        msgDetail: JSON.stringify(jsonRpcResponse),
    };

    await wsManager.sendMessage(sessionId, outboundMessage);
    log(`Sent clearContext response: sessionId=${sessionId}`);
}

/**
 * Send a tasks/cancel response.
 */
export async function sendTasksCancelResponse(params) {
    const { config, sessionId, taskId, messageId } = params;
    const runtime = getXYRuntime();
    const log = runtime?.log ?? console.log;
    const error = runtime?.error ?? console.error;

    const jsonRpcResponse = {
        jsonrpc: "2.0",
        id: messageId,
        result: {
            id: taskId,
            status: {
                state: "canceled",
            },
        },
        error: {
            code: 0,
            message: "",
        },
    };

    const wsManager = getXYWebSocketManager(config);
    const outboundMessage = {
        msgType: "agent_response",
        agentId: config.agentId,
        sessionId,
        taskId,
        msgDetail: JSON.stringify(jsonRpcResponse),
    };

    await wsManager.sendMessage(sessionId, outboundMessage);
    log(`Sent tasks/cancel response: sessionId=${sessionId}, taskId=${taskId}`);
}

/**
 * Send a Trigger response with pushData content.
 */
export async function sendTriggerResponse(params) {
    const { config, sessionId, taskId, messageId, content } = params;
    const runtime = getXYRuntime();
    const log = runtime?.log ?? console.log;
    const error = runtime?.error ?? console.error;

    const bridgedContent = rewriteOutboundApprovalText(sessionId, content);
    const redactedContent = redactSensitiveText(bridgedContent);

    const artifactParts = redactMessagePayload([
        {
            kind: "text",
            text: bridgedContent,
        },
    ], "parts");

    const jsonRpcResponse = {
        jsonrpc: "2.0",
        id: messageId,
        result: {
            taskId: taskId,
            kind: "artifact-update",
            append: false,
            lastChunk: true,
            final: true,
            artifact: {
                artifactId: uuidv4(),
                parts: artifactParts,
            },
        },
        error: {
            code: 0,
            message: "",
        },
    };

    const wsManager = getXYWebSocketManager(config);
    const outboundMessage = {
        msgType: "agent_response",
        agentId: config.agentId,
        sessionId,
        taskId,
        msgDetail: JSON.stringify(jsonRpcResponse),
    };

    log(`[TRIGGER_RESPONSE] Sending Trigger response: sessionId=${sessionId}, taskId=${taskId}`);
    log(`[TRIGGER_RESPONSE]   - text: ${buildTextPreview(redactedContent)}`);

    await wsManager.sendMessage(sessionId, outboundMessage);
    log(`[TRIGGER_RESPONSE] Trigger response sent successfully`);
}

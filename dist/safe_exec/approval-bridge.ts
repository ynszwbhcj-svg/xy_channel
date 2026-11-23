/**
 * Approval bridge for Xiaoyi channel.
 *
 * 目标：
 * 1. 把 OpenClaw 发出的 /approve 文本提示，改写成更适合 Xiaoyi 用户理解的自然语言确认提示。
 * 2. 仅在当前 session 确实存在待审批状态时，才把用户回复的“确认 / 拒绝”等短指令回写成 /approve。
 * 3. 每个 session 只保留最新的一条待审批记录，避免桥接状态无限累积。
 *
 * 注意：
 * - 这里的 Map 只是桥接层缓存，不是真正的审批来源。
 * - 真正的审批状态仍然由 OpenClaw gateway 维护。
 */

// 一键开关 Xiaoyi channel 的 approval bridge。
// false 时：
// 1. 不再改写 OpenClaw 发出的审批提示文本；
// 2. 不再缓存待审批状态；
// 3. 不再把用户回复的“确认/拒绝”翻译回 /approve。
const ENABLE_APPROVAL_BRIDGE = true;

const DEFAULT_APPROVAL_TTL_MS = 2 * 60 * 1000;

const ALLOW_ONCE_KEYWORDS = new Set([
    "确认",
    "同意",
    "允许",
    "继续",
    "确认执行",
    "继续执行",
    "ok",
    "okay",
    "yes",
    "y",
]);

const ALLOW_ALWAYS_KEYWORDS = new Set([
    "总是允许",
    "始终允许",
    "一直允许",
    "永久允许",
    "以后都允许",
    "全部允许",
]);

const DENY_KEYWORDS = new Set([
    "拒绝",
    "取消",
    "不同意",
    "停止",
    "停止执行",
    "deny",
    "no",
    "n",
]);

/**
 * sessionId -> 当前最新待审批记录
 */
const pendingApprovals = new Map();

function normalizeLineBreaks(text) {
    return text.replace(/\r\n/g, "\n");
}

/**
 * 只去掉首尾空白和常见标点，避免“确认。”、“ok！”这类轻微变体无法命中。
 */
function normalizeReplyText(text) {
    return text
        .trim()
        .replace(/^[\s"'`“”‘’.,!?，。！？：:;；()（）\[\]【】]+/, "")
        .replace(/[\s"'`“”‘’.,!?，。！？：:;；()（）\[\]【】]+$/, "")
        .trim()
        .toLowerCase();
}

function cleanupExpiredApprovals(now = Date.now()) {
    for (const [sessionId, record] of pendingApprovals.entries()) {
        if (record.expiresAtMs <= now) {
            pendingApprovals.delete(sessionId);
        }
    }
}

function parseAllowedDecisions(raw) {
    const normalized = typeof raw === "string" ? raw.trim() : "";
    if (!normalized) {
        return ["allow-once", "allow-always", "deny"];
    }
    const decisions = normalized
        .split("|")
        .map(item => item.trim().toLowerCase())
        .filter(item => item === "allow-once" || item === "allow-always" || item === "deny");
    return decisions.length > 0 ? decisions : ["allow-once", "allow-always", "deny"];
}

function extractApprovalCommandId(replyCommandId, explicitApprovalId) {
    const normalizedReplyId = typeof replyCommandId === "string" ? replyCommandId.trim() : "";
    const normalizedApprovalId = typeof explicitApprovalId === "string" ? explicitApprovalId.trim() : "";
    if (normalizedApprovalId) {
        return normalizedApprovalId;
    }
    if (normalizedReplyId && normalizedReplyId !== "<id>") {
        return normalizedReplyId;
    }
    return "";
}

function buildDecisionHint(allowedDecisions) {
    const hints = [];
    if (allowedDecisions.includes("allow-once")) {
        hints.push("“确认”");
    }
    if (allowedDecisions.includes("allow-always")) {
        hints.push("“总是允许”");
    }
    if (allowedDecisions.includes("deny")) {
        hints.push("“拒绝”");
    }
    if (hints.length === 0) {
        return "请回复确认结果。";
    }
    if (hints.length === 1) {
        return `请回复 ${hints[0]}。`;
    }
    if (hints.length === 2) {
        return `请回复 ${hints[0]} 或 ${hints[1]}。`;
    }
    return `请回复 ${hints[0]}、${hints[1]} 或 ${hints[2]}。`;
}

function buildExecApprovalPrompt(record) {
    const lines = ["检测到需要人工确认的高风险命令。"];
    if (record.warningText) {
        lines.push(`说明：${record.warningText}`);
    }
    lines.push(`执行位置：${record.host === "node" ? "node" : "gateway"}`);
    if (record.cwd) {
        lines.push(`工作目录：${record.cwd}`);
    }
    if (record.command) {
        lines.push("待执行命令：");
        lines.push("```sh");
        lines.push(record.command);
        lines.push("```");
    }
    lines.push(buildDecisionHint(record.allowedDecisions));
    return lines.join("\n");
}

function buildPluginApprovalPrompt(record) {
    const lines = ["检测到当前操作需要人工确认。"];
    if (record.title) {
        lines.push(`标题：${record.title}`);
    }
    if (record.description) {
        lines.push(`说明：${record.description}`);
    }
    if (record.toolName) {
        lines.push(`工具：${record.toolName}`);
    }
    if (record.pluginId) {
        lines.push(`来源插件：${record.pluginId}`);
    }
    lines.push(buildDecisionHint(record.allowedDecisions));
    return lines.join("\n");
}

function buildApprovalPrompt(record) {
    return record.kind === "exec"
        ? buildExecApprovalPrompt(record)
        : buildPluginApprovalPrompt(record);
}

function parseExecApprovalPrompt(text) {
    const normalized = normalizeLineBreaks(text);
    const headerMatch = normalized.match(/Approval required \(id ([^,\n]+), full ([^)]+)\)\./i);
    const replyMatch = normalized.match(/Reply with:\s*\/approve\s+([^\s]+)\s+([A-Za-z|-]+)/i);
    if (!headerMatch || !replyMatch) {
        return null;
    }
    const commandMatch = normalized.match(/Command:\n```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n```/i);
    const hostMatch = normalized.match(/^Host:\s*(.+)$/im);
    const cwdMatch = normalized.match(/^CWD:\s*(.+)$/im);
    const warningIndex = normalized.indexOf("Approval required");
    const warningText = warningIndex > 0 ? normalized.slice(0, warningIndex).trim() : "";
    const allowedDecisions = parseAllowedDecisions(replyMatch[2]);
    const approvalId = extractApprovalCommandId(replyMatch[1], headerMatch[2]);
    if (!approvalId) {
        return null;
    }
    return {
        kind: "exec",
        approvalId,
        approvalSlug: headerMatch[1].trim(),
        allowedDecisions,
        command: commandMatch?.[1]?.trim() ?? "",
        host: hostMatch?.[1]?.trim() === "node" ? "node" : "gateway",
        cwd: cwdMatch?.[1]?.trim() ?? "",
        warningText,
    };
}

function parsePluginApprovalPrompt(text) {
    const normalized = normalizeLineBreaks(text);
    if (!/Plugin approval required/i.test(normalized)) {
        return null;
    }
    const idMatch = normalized.match(/^ID:\s*(.+)$/im);
    const replyMatch = normalized.match(/Reply with:\s*\/approve\s+([^\s]+)\s+([A-Za-z|-]+)/i);
    const titleMatch = normalized.match(/^Title:\s*(.+)$/im);
    const descriptionMatch = normalized.match(/^Description:\s*(.+)$/im);
    const toolMatch = normalized.match(/^Tool:\s*(.+)$/im);
    const pluginMatch = normalized.match(/^Plugin:\s*(.+)$/im);
    const agentMatch = normalized.match(/^Agent:\s*(.+)$/im);
    const expiresMatch = normalized.match(/^Expires in:\s*(\d+)s$/im);
    const allowedDecisions = parseAllowedDecisions(replyMatch?.[2]);
    const approvalId = extractApprovalCommandId(replyMatch?.[1], idMatch?.[1]);
    if (!approvalId) {
        return null;
    }
    return {
        kind: "plugin",
        approvalId,
        approvalSlug: approvalId.slice(0, 8),
        allowedDecisions,
        title: titleMatch?.[1]?.trim() ?? "",
        description: descriptionMatch?.[1]?.trim() ?? "",
        toolName: toolMatch?.[1]?.trim() ?? "",
        pluginId: pluginMatch?.[1]?.trim() ?? "",
        agentId: agentMatch?.[1]?.trim() ?? "",
        expiresInMs: expiresMatch ? Number(expiresMatch[1]) * 1000 : undefined,
    };
}

function parseApprovalPrompt(text) {
    return parseExecApprovalPrompt(text) ?? parsePluginApprovalPrompt(text);
}

function parseApprovalSubmissionAcknowledgement(text) {
    const normalized = normalizeLineBreaks(text).trim();
    const commandAckMatch = normalized.match(/^[✅✔]?\s*Approval\s+(allow-once|allow-always|deny)\s+submitted\s+for\s+(.+?)\.?$/i);
    if (commandAckMatch) {
        return { decision: commandAckMatch[1].toLowerCase() };
    }
    const pluginAckMatch = normalized.match(/^[✅✔]?\s*Plugin approval\s+(allowed once|allowed always|denied)\./i);
    if (pluginAckMatch) {
        const decisionLabel = pluginAckMatch[1].toLowerCase();
        if (decisionLabel === "allowed always") {
            return { decision: "allow-always" };
        }
        if (decisionLabel === "denied") {
            return { decision: "deny" };
        }
        return { decision: "allow-once" };
    }
    return null;
}

function parseApprovalSubmissionFailure(text) {
    const normalized = normalizeLineBreaks(text).trim();
    const failureMatch = normalized.match(/^[❌x]\s*Failed to submit approval:\s*(.+)$/i);
    if (!failureMatch) {
        return null;
    }
    return failureMatch[1].trim();
}

function buildApprovalAcknowledgement(decision) {
    if (decision === "allow-always") {
        return "已确认并允许后续自动执行，任务会继续处理。";
    }
    if (decision === "deny") {
        return "已拒绝本次执行。";
    }
    return "已确认本次执行，任务会继续处理。";
}

function buildApprovalFailureMessage(reason) {
    if (/unknown or expired approval id|approval expired or not found/i.test(reason)) {
        return "确认失败：当前审批已过期或不存在，请重新发起任务。";
    }
    return `确认失败：${reason}`;
}

function rememberApproval(sessionId, parsed) {
    const now = Date.now();
    const expiresAtMs = now + (parsed.expiresInMs ?? DEFAULT_APPROVAL_TTL_MS);
    pendingApprovals.set(sessionId, {
        ...parsed,
        sessionId,
        createdAtMs: now,
        expiresAtMs,
    });
}

function resolveApprovalDecision(record, text) {
    const normalized = normalizeReplyText(text);
    if (!normalized) {
        return null;
    }
    if (record.allowedDecisions.includes("allow-always") && ALLOW_ALWAYS_KEYWORDS.has(normalized)) {
        return "allow-always";
    }
    if (record.allowedDecisions.includes("deny") && DENY_KEYWORDS.has(normalized)) {
        return "deny";
    }
    if (record.allowedDecisions.includes("allow-once") && ALLOW_ONCE_KEYWORDS.has(normalized)) {
        return "allow-once";
    }
    return null;
}

/**
 * 出站改写：
 * - 如果是审批提示，则记录待审批状态，并输出更友好的确认文案。
 * - 如果是 /approve 的成功或失败回执，则改写成用户更容易理解的文本。
 */
export function rewriteOutboundApprovalText(sessionId, text) {
    if (!ENABLE_APPROVAL_BRIDGE) {
        return text;
    }
    cleanupExpiredApprovals();
    if (!sessionId || typeof text !== "string" || text.trim() === "") {
        return text;
    }
    const acknowledgement = parseApprovalSubmissionAcknowledgement(text);
    if (acknowledgement) {
        pendingApprovals.delete(sessionId);
        return buildApprovalAcknowledgement(acknowledgement.decision);
    }
    const failureReason = parseApprovalSubmissionFailure(text);
    if (failureReason) {
        if (/unknown or expired approval id|approval expired or not found/i.test(failureReason)) {
            pendingApprovals.delete(sessionId);
        }
        return buildApprovalFailureMessage(failureReason);
    }
    const parsed = parseApprovalPrompt(text);
    if (!parsed) {
        return text;
    }
    rememberApproval(sessionId, parsed);
    return buildApprovalPrompt({
        ...parsed,
        sessionId,
    });
}

/**
 * 入站改写：
 * - 先检查当前 session 是否存在有效待审批状态。
 * - 只有存在待审批状态时，才把“确认 / 拒绝”等短回复翻译成 /approve。
 * - 没有待审批状态时，完全不介入，避免影响普通对话。
 */
export function rewriteInboundApprovalText(sessionId, text) {
    if (!ENABLE_APPROVAL_BRIDGE) {
        return { matched: false, rewrittenText: text };
    }
    cleanupExpiredApprovals();
    if (!sessionId || typeof text !== "string" || text.trim() === "") {
        return { matched: false, rewrittenText: text };
    }
    const record = pendingApprovals.get(sessionId);
    if (!record) {
        return { matched: false, rewrittenText: text };
    }
    const decision = resolveApprovalDecision(record, text);
    if (!decision) {
        return { matched: false, rewrittenText: text };
    }
    pendingApprovals.delete(sessionId);
    return {
        matched: true,
        decision,
        approvalId: record.approvalId,
        rewrittenText: `/approve ${record.approvalId} ${decision}`,
    };
}

/**
 * 清理指定 session 的待审批状态。
 * 用于 clearContext / cancel 等显式结束会话的场景。
 */
export function clearPendingApproval(sessionId) {
    if (!ENABLE_APPROVAL_BRIDGE) {
        return;
    }
    if (!sessionId) {
        return;
    }
    pendingApprovals.delete(sessionId);
}

/**
 * 仅用于本地调试或测试。
 */
export function getPendingApproval(sessionId) {
    if (!ENABLE_APPROVAL_BRIDGE) {
        return null;
    }
    cleanupExpiredApprovals();
    return pendingApprovals.get(sessionId) ?? null;
}

/**
 * 仅用于本地调试或测试。
 */
export function clearAllPendingApprovals() {
    pendingApprovals.clear();
}

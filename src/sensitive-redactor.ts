import fs from "fs";
import path from "path";

// 一键开关 Xiaoyi channel 的敏感信息脱敏与检测能力。
// false 时：
// 1. 不再读取 openclaw.json / .xiaoyienv 提取敏感值；
// 2. 不再对消息内容做脱敏替换；
// 3. 不再做 Base64 绕过检测；
// 4. containsSensitiveInfo 一律返回 false。
const ENABLE_SENSITIVE_REDACTION = true;

let sensitiveValues = null;
let lastLoadTime = 0;

const CACHE_TTL_MS = 60 * 1000;
const REDACTED_MARKER = "[execution-validator已脱敏]";
const BASE64_CANDIDATE_RE = /(?<![A-Za-z0-9+/_-])([A-Za-z0-9+/]{12,}={0,2}|[A-Za-z0-9_-]{12,})(?![A-Za-z0-9+/_-])/g;

const SECRET_KEYWORDS = [
    "apikey",
    "token",
    "secret",
    "password",
    "passwd",
    "pwd",
    "authorization",
    "cookie",
    "session",
    "signature",
    "sign",
];

const ID_KEYWORDS = [
    "agentid",
    "apiid",
    "uid",
    "pushid",
    "userid",
    "accountid",
    "clientid",
    "appid",
];

const URL_KEYWORDS = [
    "url",
    "endpoint",
];

const PLACEHOLDER_VALUES = new Set([
    "apikey",
    "api-key",
    "api_key",
    "token",
    "secret",
    "password",
    "passwd",
    "pwd",
    "authorization",
    "bearer",
    "openclaw",
    "text/event-stream",
]);

function getConfigRoot() {
    return process.env.HOME || "/home/sandbox";
}

function normalizeKeyName(key) {
    return String(key ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeValue(value) {
    return String(value ?? "").trim();
}

function matchesKeyword(normalizedKey, keywords) {
    return keywords.some(keyword => normalizedKey.includes(keyword));
}

function isPlaceholderValue(value) {
    const normalized = normalizeValue(value).toLowerCase();
    if (!normalized) {
        return true;
    }
    if (PLACEHOLDER_VALUES.has(normalized)) {
        return true;
    }
    if (/^(my|your|demo|test)?(apikey|token|secret|password)$/.test(normalized)) {
        return true;
    }
    return false;
}

function looksLikeToken(value) {
    const trimmed = normalizeValue(value);
    if (trimmed.length < 8 || isPlaceholderValue(trimmed)) {
        return false;
    }
    if (/^(sk-|sk_)[a-z0-9]/i.test(trimmed)) {
        return true;
    }
    if (/^[a-f0-9]{24,}$/i.test(trimmed)) {
        return true;
    }
    if (/^[A-Za-z0-9._/+\\=-]{16,}$/.test(trimmed) && /[A-Za-z]/.test(trimmed) && /\d/.test(trimmed)) {
        return true;
    }
    return false;
}

function looksLikeIdentifier(value) {
    const trimmed = normalizeValue(value);
    if (trimmed.length < 6 || isPlaceholderValue(trimmed)) {
        return false;
    }
    if (/^agent[a-z0-9]{8,}$/i.test(trimmed)) {
        return true;
    }
    if (/^webhook[a-z0-9]{6,}$/i.test(trimmed)) {
        return true;
    }
    if (/^\d{6,}$/.test(trimmed)) {
        return true;
    }
    if (/^[A-Za-z][A-Za-z0-9_-]{10,}$/.test(trimmed) && /\d/.test(trimmed)) {
        return true;
    }
    return false;
}

function looksLikeSensitiveUrl(value) {
    const trimmed = normalizeValue(value);
    try {
        const parsed = new URL(trimmed);
        if (parsed.username || parsed.password) {
            return true;
        }
        for (const [name, paramValue] of parsed.searchParams.entries()) {
            const normalizedName = normalizeKeyName(name);
            if ((matchesKeyword(normalizedName, SECRET_KEYWORDS) || matchesKeyword(normalizedName, ID_KEYWORDS))
                && normalizeValue(paramValue).length > 5) {
                return true;
            }
        }
        const segments = parsed.pathname.split("/").filter(Boolean);
        return segments.some(segment => looksLikeToken(segment));
    }
    catch {
        return false;
    }
}

function shouldKeepSensitiveValue(key, value) {
    const trimmed = normalizeValue(value);
    if (trimmed.length <= 5 || isPlaceholderValue(trimmed)) {
        return false;
    }

    const normalizedKey = normalizeKeyName(key);

    if (matchesKeyword(normalizedKey, SECRET_KEYWORDS)) {
        return looksLikeToken(trimmed) || looksLikeSensitiveUrl(trimmed);
    }

    if (matchesKeyword(normalizedKey, ID_KEYWORDS)) {
        return looksLikeIdentifier(trimmed) || looksLikeToken(trimmed);
    }

    if (matchesKeyword(normalizedKey, URL_KEYWORDS)) {
        return looksLikeSensitiveUrl(trimmed);
    }

    return looksLikeToken(trimmed);
}

function addSensitiveValue(values, key, value) {
    if (shouldKeepSensitiveValue(key, value)) {
        values.push(String(value));
    }
}

function extractSensitiveValues() {
    const values = [];

    try {
        const openclawJsonPath = path.join(getConfigRoot(), ".openclaw", "openclaw.json");
        if (fs.existsSync(openclawJsonPath)) {
            const content = fs.readFileSync(openclawJsonPath, "utf-8");
            const config = JSON.parse(content);

            if (config.channels) {
                for (const channelName of Object.keys(config.channels)) {
                    const channel = config.channels[channelName];
                    addSensitiveValue(values, "apiKey", channel.apiKey);
                    addSensitiveValue(values, "agentId", channel.agentId);
                    addSensitiveValue(values, "apiId", channel.apiId);
                    addSensitiveValue(values, "uid", channel.uid);
                    addSensitiveValue(values, "pushId", channel.pushId);
                    addSensitiveValue(values, "wsUrl1", channel.wsUrl1);
                    addSensitiveValue(values, "wsUrl2", channel.wsUrl2);
                }
            }

            if (config.models?.providers) {
                for (const providerName of Object.keys(config.models.providers)) {
                    const provider = config.models.providers[providerName];
                    addSensitiveValue(values, "apiKey", provider.apiKey);
                    addSensitiveValue(values, "baseUrl", provider.baseUrl);

                    if (provider.headers) {
                        for (const headerKey of Object.keys(provider.headers)) {
                            addSensitiveValue(values, headerKey, provider.headers[headerKey]);
                        }
                    }
                }
            }

            addSensitiveValue(values, "token", config.gateway?.auth?.token);

            console.log(`[SENSITIVE_REDACTOR] Extracted ${values.length} sensitive values from openclaw.json`);
        }
    }
    catch (err) {
        console.error("[SENSITIVE_REDACTOR] Failed to read openclaw.json:", err);
    }

    try {
        const xiaoyienvPath = path.join(getConfigRoot(), ".openclaw", ".xiaoyienv");
        if (fs.existsSync(xiaoyienvPath)) {
            const content = fs.readFileSync(xiaoyienvPath, "utf-8");

            try {
                const envConfig = JSON.parse(content);
                for (const key of Object.keys(envConfig)) {
                    addSensitiveValue(values, key, envConfig[key]);
                }
            }
            catch {
                const lines = content.split("\n");
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed && !trimmed.startsWith("#")) {
                        const eqIndex = trimmed.indexOf("=");
                        if (eqIndex > 0) {
                            const key = trimmed.slice(0, eqIndex).trim();
                            const value = trimmed.slice(eqIndex + 1).trim();
                            addSensitiveValue(values, key, value);
                        }
                    }
                }
            }

            console.log(`[SENSITIVE_REDACTOR] Total sensitive values after .xiaoyienv: ${values.length}`);
        }
    }
    catch (err) {
        console.error("[SENSITIVE_REDACTOR] Failed to read .xiaoyienv:", err);
    }

    const uniqueValues = [...new Set(values)].filter(value => typeof value === "string" && value.length > 5);
    uniqueValues.sort((a, b) => b.length - a.length);
    return uniqueValues;
}

function getSensitiveValues() {
    if (!ENABLE_SENSITIVE_REDACTION) {
        return [];
    }
    const now = Date.now();
    if (sensitiveValues === null || now - lastLoadTime > CACHE_TTL_MS) {
        sensitiveValues = extractSensitiveValues();
        lastLoadTime = now;
    }
    return sensitiveValues;
}

export function refreshSensitivePatterns() {
    sensitiveValues = null;
    lastLoadTime = 0;
    if (ENABLE_SENSITIVE_REDACTION) {
        getSensitiveValues();
    }
}

function maskSensitiveValue(value) {
    return REDACTED_MARKER;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsSensitiveValue(text, values) {
    const normalizedText = String(text).toLowerCase();
    for (const sensitiveValue of values) {
        if (sensitiveValue && normalizedText.includes(String(sensitiveValue).toLowerCase())) {
            return true;
        }
    }
    return false;
}

function replaceSensitiveValues(text, values) {
    let result = text;
    for (const sensitiveValue of values) {
        if (sensitiveValue && containsSensitiveValue(result, [sensitiveValue])) {
            const masked = maskSensitiveValue(sensitiveValue);
            result = result.replace(new RegExp(escapeRegExp(sensitiveValue), "gi"), masked);
        }
    }
    return result;
}

// 从文本里提取“看起来像 Base64”的连续片段。
// 这里只做候选收集，是否真的需要脱敏由解码后的匹配结果决定。
function extractBase64Candidates(text) {
    return [...text.matchAll(BASE64_CANDIDATE_RE)].map(match => match[1]);
}

// 尝试把候选片段按 Base64 / Base64URL 解码。
// 解码失败时返回 null，交给上层继续处理其他候选。
function tryDecodeBase64(input) {
    try {
        let normalized = input.replace(/-/g, "+").replace(/_/g, "/");
        const mod = normalized.length % 4;
        if (mod) {
            normalized += "=".repeat(4 - mod);
        }
        const decoded = Buffer.from(normalized, "base64").toString("utf8");
        if (!decoded) {
            return null;
        }
        return decoded;
    }
    catch {
        return null;
    }
}

export function redactSensitiveText(text) {
    if (!ENABLE_SENSITIVE_REDACTION) {
        return text;
    }
    if (!text || typeof text !== "string") {
        return text;
    }

    const values = getSensitiveValues();
    let result = replaceSensitiveValues(text, values);

    // 先按原文直接匹配；只有没命中时才继续尝试 Base64 绕过检测。
    if (result !== text) {
        return result;
    }

    const candidates = extractBase64Candidates(text);
    for (const candidate of candidates) {
        const decoded = tryDecodeBase64(candidate);
        if (!decoded) {
            continue;
        }
        if (containsSensitiveValue(decoded, values)) {
            result = result.split(candidate).join(REDACTED_MARKER);
        }
    }

    return result;
}

export function redactSensitiveObject(obj) {
    if (!ENABLE_SENSITIVE_REDACTION) {
        return obj;
    }
    if (obj === null || obj === undefined) {
        return obj;
    }

    if (typeof obj === "string") {
        return redactSensitiveText(obj);
    }

    if (Array.isArray(obj)) {
        return obj.map(item => redactSensitiveObject(item));
    }

    if (typeof obj === "object") {
        const result = {};
        for (const key of Object.keys(obj)) {
            result[key] = redactSensitiveObject(obj[key]);
        }
        return result;
    }

    return obj;
}

export function containsSensitiveInfo(text) {
    if (!ENABLE_SENSITIVE_REDACTION) {
        return false;
    }
    if (!text || typeof text !== "string") {
        return false;
    }

    const values = getSensitiveValues();
    if (containsSensitiveValue(text, values)) {
        return true;
    }

    const candidates = extractBase64Candidates(text);
    for (const candidate of candidates) {
        const decoded = tryDecodeBase64(candidate);
        if (decoded && containsSensitiveValue(decoded, values)) {
            return true;
        }
    }

    return false;
}

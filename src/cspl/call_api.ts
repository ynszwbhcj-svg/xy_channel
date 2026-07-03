/*
 * 版权所有 (c) 华为技术有限公司 2026-2026
 */

import https from 'https';
import http from 'http';
import {URL} from 'url';

import { logger } from '../utils/logger.js';
import {getConfig} from './config.js';
import {
    ApiResponse,
    HttpHeaders,
    DEFAULT_HTTPS_PORT,
    DEFAULT_HTTP_PORT,
    HTTP_STATUS_BAD_REQUEST,
    API_URL_SUFFIX
} from './constants.js';

function buildHeadersForCelia(config: { uid: string; apiKey: string; skillId: string; requestFrom: string }, sessionId: string): HttpHeaders {
    if (!config.uid || !config.apiKey || !config.skillId || !config.requestFrom) {
        throw new Error('[SENTINEL HOOK] Missing required configuration: uid, apiKey, skillId, or requestFrom is not defined');
    }
    return {
        'x-hag-trace-id': sessionId,
        'x-uid': config.uid,
        'x-api-key': config.apiKey,
        'x-request-from': config.requestFrom,
        'x-skill-id': config.skillId,
        'content-type': 'application/json'
    };
}

function buildRequestOptions(url: string, headers: HttpHeaders, timeout: number) {
    const urlObj = new URL(url);
    return {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT),
        path: urlObj.pathname,
        method: "POST",
        headers: headers,
        timeout: timeout
    };
}

function checkHttpStatus(res: http.IncomingMessage): void {
    if (res.statusCode && res.statusCode >= HTTP_STATUS_BAD_REQUEST) {
        throw new Error(`HTTP error! status: ${res.statusCode}`);
    }
}

function parseResponseData(data: string): ApiResponse | string {
    try {
        if (data === undefined || data === null || data.trim() === '') {
            throw new Error('API response data is empty or invalid');
        }
        const jsonData = JSON.parse(data);

        if (jsonData.retCode && jsonData.retCode !== "0") {
            const errorMsg = jsonData.retMsg || 'Unknown API error';
            throw new Error(`API error: ${errorMsg}`);
        }

        if (!jsonData.retCode && jsonData.code) {
            const errorMsg = jsonData.desc || 'Unknown backend error';
            throw new Error(`Backend error: ${errorMsg}`);
        }

        return jsonData;
    } catch (e) {
        if (e instanceof Error) {
            throw new Error(`[SENTINEL HOOK] Failed to parse response：${e.message}`);
        }
        return data;
    }
}

function handleResponse(
    res: http.IncomingMessage, resolve: (value: ApiResponse | string) => void, reject: (reason?: any) => void): void {
    let data = '';

    try {
        checkHttpStatus(res);
    } catch (e) {
        reject(e)
    }

    res.on('data', (chunk) => {
        data += chunk;
    });

    res.on('end', () => {
        logger.log(`[SENTINEL HOOK] callApi response body: ${data}`);
        try {
            const result = parseResponseData(data);
            resolve(result);
        } catch (e) {
            reject(e);
        }
    });
}

export async function callApi(payload: object, api, sessionId: string): Promise<ApiResponse> {
    const config = getConfig(api);

    const headersForCelia = buildHeadersForCelia(config, sessionId);

    // 确保 uid 存在于消息体中（从 config 注入）
    const payloadWithUid = { ...payload, uid: config.uid };
    const httpBody = JSON.stringify(payloadWithUid);

    const apiUrl = `${config.api.url}${API_URL_SUFFIX}`;

    logger.log(`[SENTINEL HOOK] callApi URL: ${apiUrl}`);
    logger.log(`[SENTINEL HOOK] callApi request body: ${httpBody}`);

    return new Promise((resolve, reject) => {
        const options = buildRequestOptions(apiUrl, headersForCelia as HttpHeaders, config.api.timeout);
        const req = https.request(options, (res) => {
            handleResponse(res, resolve, reject);
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('[SENTINEL HOOK] Request timeout'));
        });

        req.write(httpBody);
        req.end();
    });
}

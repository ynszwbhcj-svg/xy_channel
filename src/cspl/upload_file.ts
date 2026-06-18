/*
 * 版权所有 (c) 华为技术有限公司 2026-2026
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { URL } from 'url';
import { Buffer } from 'buffer';

import { getConfig } from './config.js';
import {
    HttpHeaders,
    DEFAULT_HTTP_PORT,
    DEFAULT_HTTPS_PORT,
    MAX_TIMES,
    CONNECT_TIMEOUT,
    READ_TIMEOUT,
    EXPIRE_TIME,
    OSMS_PREPARE_URL,
    OSMS_COMPLETE_URL,
    TEMPORARY_MATERIAL_PACKAGE,
    FILE_OWNER_UID,
    FILE_OWNER_TEAM_ID,
    UploadInfo,
    PrepareResponse,
    CompleteResponse
} from './constants.js';

function buildOsmsHeaders(config: { uid: string; apiKey: string }, traceId: string): HttpHeaders {
    return {
        'content-type': 'application/json',
        'x-request-from': 'openclaw',
        'x-uid': config.uid,
        'x-api-key': config.apiKey,
        'x-hag-trace-id': traceId,
        'x-skill-id': ''
    };
}

function httpRequest(
    url: string,
    method: string,
    headers: HttpHeaders,
    body: string | null,
    timeout: number
): Promise<string> {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || DEFAULT_HTTPS_PORT,
            path: urlObj.pathname + urlObj.search,
            method: method,
            headers: headers,
            timeout: timeout,
            rejectUnauthorized: false
        };

        const req = https.request(options as any, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`HTTP error! status: ${res.statusCode}, body: ${data}`));
                } else {
                    resolve(data);
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        if (body) {
            req.write(body);
        }
        req.end();
    });
}

async function invokingOsmsPrepare(
    filePath: string,
    config: { uid: string; apiKey: string; serviceUrl: string },
    fileSha256: string,
    fileSize: number,
    sessionId: string
): Promise<PrepareResponse> {
    const headers = buildOsmsHeaders(config, sessionId);

    const fileName = path.basename(filePath);

    const body = JSON.stringify({
        useEdge: false,
        objectType: TEMPORARY_MATERIAL_PACKAGE,
        fileName: fileName,
        fileSha256: fileSha256,
        fileSize: fileSize,
        fileOwnerInfo: {
            uid: FILE_OWNER_UID,
            teamId: FILE_OWNER_TEAM_ID
        }
    });

    const prepareUrl = `${config.serviceUrl}${OSMS_PREPARE_URL}`;

    for (let times = 0; times < MAX_TIMES; times++) {
        try {
            const responseData = await httpRequest(prepareUrl, 'POST', headers, body, CONNECT_TIMEOUT);
            const resp = JSON.parse(responseData);

            if (!resp.objectId || !resp.draftId || !resp.uploadInfos) {
                throw new Error('The hag osms prepare interface returns an exception');
            }

            if (!resp.uploadInfos || resp.uploadInfos.length === 0) {
                throw new Error('The hag osms prepare interface uploadInfos returns is empty');
            }

            const uploadInfo = resp.uploadInfos[0];
            if (!uploadInfo.url || !uploadInfo.headers) {
                throw new Error('The hag osms prepare interface url and headers for uploadInfos map returns is empty');
            }

            return resp;
        } catch (e) {
            if (times === MAX_TIMES - 1) {
                throw e;
            }
        }
    }

    throw new Error('Failed to invoke OSMS prepare interface after max retries');
}

function readFileAsBytes(filePath: string): Buffer {
    try {
        return fs.readFileSync(filePath);
    } catch (error) {
        const err = error as Error;
        throw new Error(`Failed to read file: ${filePath}. Error: ${err.message}`);
    }
}

async function uploadFileToObs(uploadInfo: UploadInfo, fileBytes: Buffer): Promise<boolean> {
    let retryDelay = 1;
    let retryTime = 1;

    while (true) {
        try {
            const urlObj = new URL(uploadInfo.url);
            const options = {
                hostname: urlObj.hostname,
                port: urlObj.port || DEFAULT_HTTPS_PORT,
                path: urlObj.pathname + urlObj.search,
                method: 'PUT',
                headers: {
                    ...uploadInfo.headers,
                    'content-length': fileBytes.length.toString(),},
                timeout: READ_TIMEOUT,
                rejectUnauthorized: false
            };
            await new Promise<void>((resolve, reject) => {
                const req = https.request(options as any, (res) => {
                    let data = '';
                    res.on('data', (chunk) => {
                        data += chunk;
                    });
                    res.on('end', () => {
                        if (res.statusCode && res.statusCode >= 400) {
                            reject(new Error(`Upload failed with status: ${res.statusCode}, body: ${data}`));
                        } else {
                            resolve();
                        }
                    });
                });

                req.on('error', (error) => {
                    reject(error);
                });

                req.on('timeout', () => {
                    req.destroy();
                    reject(new Error('Upload timeout'));
                });

                req.write(fileBytes);
                req.end();
            });

            return true;
        } catch (e) {
            retryTime++;
            if (retryTime > MAX_TIMES) {
                throw new Error(`Upload file to obs failed: ${(e as Error).message}`);
            }
            await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, retryTime)));
        }
    }
}

async function invokingOsmsComplete(
    objectId: string,
    draftId: string,
    config: { uid: string; apiKey: string; serviceUrl: string },
    sessionId: string
): Promise<CompleteResponse> {
    const headers = buildOsmsHeaders(config, sessionId);

    const body = JSON.stringify({
        objectId: objectId,
        draftId: draftId,
        expireTime: EXPIRE_TIME
    });

    const completeUrl = `${config.serviceUrl}${OSMS_COMPLETE_URL}`;

    for (let times = 0; times < MAX_TIMES; times++) {
        try {
            const responseData = await httpRequest(completeUrl, 'POST', headers, body, CONNECT_TIMEOUT);
            const resp = JSON.parse(responseData);
            return resp;
        } catch (e) {
            if (times === MAX_TIMES - 1) {
                throw e;
            }
        }
    }

    throw new Error('Failed to invoke OSMS complete interface after max retries');
}

export async function uploadFileToObsMain(
    filePath: string,
    api,
    fileHash: string,
    sessionId: string
): Promise<string> {
    const config = getConfig(api);
    const serviceUrl = config.api.url;

    const obsConfig = {
        uid: config.uid,
        apiKey: config.apiKey,
        serviceUrl: serviceUrl
    };

    const fileSize = fs.statSync(filePath).size;

    const prepareResponse = await invokingOsmsPrepare(filePath, obsConfig, fileHash, fileSize, sessionId);

    let fileBytes: Buffer;
    try {
        fileBytes = readFileAsBytes(filePath);
    } catch (error) {
        const err = error as Error;
        throw new Error(`Failed to read file for upload: ${filePath}. Error: ${err.message}`);
    }

    const uploadInfo: UploadInfo = {
        url: prepareResponse.uploadInfos[0].url,
        headers: prepareResponse.uploadInfos[0].headers
    };

    await uploadFileToObs(uploadInfo, fileBytes);

    const completeResponse = await invokingOsmsComplete(
        prepareResponse.objectId,
        prepareResponse.draftId,
        obsConfig,
        sessionId
    );

    if (!completeResponse.fileDetailInfo || !completeResponse.fileDetailInfo.url) {
        throw new Error('Failed to get download URL from complete response');
    }

    return completeResponse.fileDetailInfo.url;
}
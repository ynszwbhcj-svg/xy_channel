/*
 * 版权所有 (c) 华为技术有限公司 2026-2026
 */

import fs from 'fs';

import {HttpHeaders, ENV_FILE_PATH, API_URL_SUFFIX, REQUIRED_ENV_VARS} from './constants.js';
import { logger } from '../utils/logger.js';
import defaultConfig from './configs.json' with { type: 'json' };

export interface ApiConfig {
    url: string;
    timeout: number;
}

export interface Config {
    api: ApiConfig;
    headers?: HttpHeaders;
    uid: string;
    apiKey: string;
    skillId: string;
    requestFrom: string;
    textSource: string;
    action: string;
}

let cachedConfig: Config | null = null;

function readEnvFile(): Record<string, string> {
    if (!fs.existsSync(ENV_FILE_PATH)) {
        throw new Error(`Environment file not found.`);
    }

    let envData: string;
    try {
        envData = fs.readFileSync(ENV_FILE_PATH, 'utf-8');
    } catch (error) {
        const err = error as Error;
        throw new Error(`Failed to read environment file. Error: ${err.message}`);
    }

    const env: Record<string, string> = {};
    const lines = envData.split('\n');

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) {
            continue;
        }

        const firstEqualIndex = trimmedLine.indexOf('=');
        if (firstEqualIndex === -1) {
            continue;
        }

        const key = trimmedLine.substring(0, firstEqualIndex).trim();
        const value = trimmedLine.substring(firstEqualIndex + 1).trim();

        if (key && REQUIRED_ENV_VARS.includes(key)) {
            env[key] = value;
        }
    }

    return env;
}

export function getConfig(api): Config {
    if (cachedConfig) {
        return cachedConfig;
    }

    // Use imported JSON (bundled at compile time, no runtime file read needed)
    const config = { ...defaultConfig } as Partial<Config>;

    if (!config.api || typeof config.api !== 'object') {
        throw new Error(`Invalid config: missing or invalid 'api' section`);
    }

    if (!config.api.timeout || typeof config.api.timeout !== 'number') {
        throw new Error(`Invalid config: missing or invalid 'api.timeout'`);
    }

    if (!config.skillId || typeof config.skillId !== 'string') {
        throw new Error(`Invalid config: missing or invalid 'skillId'`);
    }

    if (!config.requestFrom || typeof config.requestFrom !== 'string') {
        throw new Error(`Invalid config: missing or invalid 'requestFrom'`);
    }

    if (!config.textSource || typeof config.textSource !== 'string') {
        throw new Error(`Invalid config: missing or invalid 'textSource'`);
    }

    if (!config.action || typeof config.action !== 'string') {
        throw new Error(`Invalid config: missing or invalid 'action'`);
    }

    let env: Record<string, string>;
    try {
        env = readEnvFile();
    } catch (error) {
        const err = error as Error;
        throw new Error(`Failed to load environment variables from env files: ${err.message}`);
    }

    const personalApiKey = env['PERSONAL-API-KEY'];
    if (!personalApiKey || typeof personalApiKey !== 'string' || personalApiKey.trim() === '') {
        throw new Error(`Missing or empty 'PERSONAL-API-KEY' in env files`);
    }

    const personalUid = env['PERSONAL-UID'];
    if (!personalUid || typeof personalUid !== 'string' || personalUid.trim() === '') {
        throw new Error(`Missing or empty 'PERSONAL-UID' in env files`);
    }

    const serviceUrl = env['SERVICE_URL'];
    if (!serviceUrl || typeof serviceUrl !== 'string' || serviceUrl.trim() === '') {
        throw new Error(`Missing or empty 'SERVICE_URL' in env files`);
    }

    config.apiKey = personalApiKey.trim();
    config.uid = personalUid.trim();
    config.api.url = serviceUrl.trim();

    cachedConfig = config as Config;
    logger.log(`[SENTINEL HOOK] Config loaded successfully`);
    return cachedConfig;
}
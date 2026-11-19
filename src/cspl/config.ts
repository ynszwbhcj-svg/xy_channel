/*
 * 版权所有 (c) 华为技术有限公司 2026-2026
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import {HttpHeaders, CONFIG_FILE_NAME, ENV_FILE_PATH, REQUIRED_ENV_VARS} from './constants.js';
import { logger } from '../utils/logger.js';

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
}

let cachedConfig: Config | null = null;

function loadEnvContent(): string {
    try {
        return fs.readFileSync(ENV_FILE_PATH, 'utf-8');
    } catch (error) {
        const err = error as Error;
        throw new Error(`Failed to read environment file. Error: ${err.message}`);
    }
}

function parseEnvLine(line: string): { key: string; value: string } | null {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) {
        return null;
    }

    const firstEqualIndex = trimmedLine.indexOf('=');
    if (firstEqualIndex === -1) {
        return null;
    }

    const key = trimmedLine.substring(0, firstEqualIndex).trim();
    const value = trimmedLine.substring(firstEqualIndex + 1).trim();
    return { key, value };
}

function readEnvFile(): Record<string, string> {
    if (!fs.existsSync(ENV_FILE_PATH)) {
        throw new Error(`Environment file not found.`);
    }

    const envData = loadEnvContent();
    const envVars: Record<string, string> = {};
    const lines = envData.split('\n');

    for (const line of lines) {
        const parsed = parseEnvLine(line);
        if (parsed && parsed.key && REQUIRED_ENV_VARS.includes(parsed.key)) {
            envVars[parsed.key] = parsed.value;
        }
    }

    return envVars;
}

function loadConfigFile(configPath: string): Record<string, unknown> {
    let configData: string;
    try {
        configData = fs.readFileSync(configPath, 'utf-8');
    } catch (error) {
        throw new Error(`Failed to read config file: ${CONFIG_FILE_NAME}.`);
    }
    try {
        return JSON.parse(configData) as Record<string, unknown>;
    } catch (error) {
        throw new Error(`Failed to parse config file: ${CONFIG_FILE_NAME}.`);
    }
}

function validateConfigStructure(config: Partial<Config>): void {
    const validators: Array<{ field: string; check: () => boolean }> = [
        { field: 'api', check: () => !config.api || typeof config.api !== 'object' },
        { field: 'api.timeout', check: () => !config.api?.timeout || typeof config.api.timeout !== 'number' },
        { field: 'skillId', check: () => !config.skillId || typeof config.skillId !== 'string' },
        { field: 'requestFrom', check: () => !config.requestFrom || typeof config.requestFrom !== 'string' },
        { field: 'textSource', check: () => !config.textSource || typeof config.textSource !== 'string' },
    ];

    for (const { field, check } of validators) {
        if (check()) {
            throw new Error(`Invalid config: missing or invalid '${field}' in ${CONFIG_FILE_NAME}`);
        }
    }
}

function validateEnvVars(): Record<string, string> {
    let envVars: Record<string, string>;
    try {
        envVars = readEnvFile();
    } catch (error) {
        const err = error as Error;
        throw new Error(`Failed to load environment variables from env files: ${err.message}`);
    }

    const personalApiKey = envVars['PERSONAL-API-KEY'];
    if (!personalApiKey || typeof personalApiKey !== 'string' || personalApiKey.trim() === '') {
        throw new Error(`Missing or empty 'PERSONAL-API-KEY' in env files`);
    }

    const personalUid = envVars['PERSONAL-UID'];
    if (!personalUid || typeof personalUid !== 'string' || personalUid.trim() === '') {
        throw new Error(`Missing or empty 'PERSONAL-UID' in env files`);
    }

    const serviceUrl = envVars.SERVICE_URL;
    if (!serviceUrl || typeof serviceUrl !== 'string' || serviceUrl.trim() === '') {
        throw new Error(`Missing or empty 'SERVICE_URL' in env files`);
    }

    return envVars;
}

export function getConfig(api): Config {
    if (cachedConfig) {
        return cachedConfig;
    }

    const configPath = path.join(__dirname, CONFIG_FILE_NAME);

    if (!fs.existsSync(configPath)) {
        throw new Error(`Config file not found: ${CONFIG_FILE_NAME}`);
    }

    const parsedConfig = loadConfigFile(configPath);
    const config = parsedConfig as Partial<Config>;

    validateConfigStructure(config);
    const envVars = validateEnvVars();

    config.apiKey = envVars['PERSONAL-API-KEY'].trim();
    config.uid = envVars['PERSONAL-UID'].trim();
    config.api.url = envVars.SERVICE_URL.trim();

    cachedConfig = config as Config;
    logger.log(`[SENTINEL HOOK] Config loaded successfully`);
    return cachedConfig;
}

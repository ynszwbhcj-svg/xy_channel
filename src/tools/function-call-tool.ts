// function-call-tool.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as dotenv from 'dotenv';
dotenv.config();
import type { SessionContext } from './session-manager.js';

// ============ Logger ============

const LOG_PREFIX = '[FCT]'; // function-call-tool

function log(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', tag: string, msg: string, data?: any): void {
  const ts = new Date().toISOString();
  const prefix = `${ts} ${LOG_PREFIX}[${level}][${tag}]`;
  if (data !== undefined) {
    const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
    fn(`${prefix} ${msg}`, data);
  } else {
    const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
    fn(`${prefix} ${msg}`);
  }
}

// ============ 类型定义 ============

interface ToolDefinition {
  schemaVersion: string;
  generatedAt: string;
  pluginId: string;
  toolName: string;
  toolType?: string;
  pluginType: 'Cloud' | 'Device' | 'MCP';
  protocol?: 'REST' | 'SSE';
  description: string;
  // [FIX #1] 字段名由 `args` 改为 `arguments`，与 Readme §7.1 规范对齐
  arguments: {
    type: string;
    properties: Record<string, any>;
    required: string[];
  };
  deviceCommand?: DeviceCommand;
}

interface DeviceCommand {
  template: {
    header: {
      namespace: string;
      name: string;
    };
    payload: {
      cardParam: Record<string, any>;
      executeParam: {
        executeMode: string;
        intentName: string;
        bundleName: string;
        needUnlock: boolean;
        actionResponse: boolean;
        appType: string;
        timeOut: number;
        intentParam: Record<string, any>;
        permissionId: string[];
        achieveType: string;
      };
      responses: Array<{
        resultCode: string;
        displayText: string;
        ttsText: string;
      }>;
      needUploadResult: boolean;
      noHalfPage: boolean;
      pageControlRelated: boolean;
    };
  };
}

interface SkillMetadata {
  name: string;
  description: string;
  'allowed-tools': string;
  metadata: {
    tools: Array<{
      pluginId: string;
      toolName: string;
    }>;
  };
}

interface ToolCache {
  [key: string]: ToolDefinition;
}

// [FIX #5] 新增冲突记录集合，供工具调用时返回 TOOL_CONFLICT 错误
const conflictedKeys = new Set<string>();

interface SkillInfo {
  name: string;
  path: string;
  metadata: SkillMetadata;
}

interface ErrorResponse {
  ok: false;
  data: null;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    detail?: any;
  };
}

interface SuccessResponse {
  ok: true;
  data: any;
  error: null;
}

type ToolResponse = SuccessResponse | ErrorResponse;

interface PluginExecutorRequest {
  version: string;
  session: {
    isNew: boolean;
    sessionId: string;
    interactionId: number;
  };
  endpoint: {
    device: {
      sid: string;
      deviceId: string;
      prdVer: string;
      phoneType: string;
      sysVer: string;
      deviceType: number;
      timezone: string;
    };
    locale: string;
    sysLocale: string;
    countryCode: string;
  };
  utterance: {
    type: string;
    original?: string;
  };
  actions: Array<{
    actionSn: string;
    actionExecutorTask: {
      pluginId: string;
      agentState: string;
      actionName: string;
      content: Record<string, any>;
    };
  }>;
}

// ============ 全局状态 ============

let toolCache: ToolCache = {};
let skillsMap: Map<string, SkillInfo> = new Map();
let currentSkillName: string | null = null;

// Xiaoyi Channel 相关配置
interface XiaoyiConfig {
  serviceUrl: string;
  apiKey: string;
  uid: string;
  traceId: () => string;
}

function expandPath(filePath: string): string {
  if (filePath.startsWith("~")) {
    return path.join(os.homedir(), filePath.slice(1).replace(/^\/+/, ""));
  }
  return filePath;
}

async function loadXiaoyiConfig(): Promise<XiaoyiConfig> {
  const envFilePath = expandPath("~/.openclaw/.xiaoyienv");
  const defaults = { serviceUrl: '', apiKey: '', uid: '' };
  log('INFO', 'CONFIG', `加载配置文件: ${envFilePath}`);

  try {
    const content = await fs.readFile(envFilePath, 'utf-8');
    const parsed: Record<string, string> = {};

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      // 跳过空行和注释
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      // 去除值两端的引号（兼容 "value" 和 'value' 格式）
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      parsed[key] = value;
    }

    return {
      serviceUrl: parsed['SERVICE_URL'] ?? defaults.serviceUrl,
      apiKey: parsed['PERSONAL_API_KEY'] ?? defaults.apiKey,
      uid: parsed['PERSONAL_UID'] ?? defaults.uid,
      traceId: () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    };
  } catch (error) {
    console.warn(`[XIAOYI_CONFIG] 无法读取 ${envFilePath}，使用空配置:`, error);
    return {
      ...defaults,
      traceId: () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    };
  }
}

// 模块级配置对象，初始为空值，由 initXiaoyiConfig() 填充
const XIAOYI_CONFIG: XiaoyiConfig = {
  serviceUrl: '',
  apiKey: '',
  uid: '',
  traceId: () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
};

async function initXiaoyiConfig(): Promise<void> {
  log('INFO', 'CONFIG', '初始化 XiaoyiConfig...');
  const loaded = await loadXiaoyiConfig();
  XIAOYI_CONFIG.serviceUrl = loaded.serviceUrl;
  XIAOYI_CONFIG.apiKey = loaded.apiKey;
  XIAOYI_CONFIG.uid = loaded.uid;
  log('INFO', 'CONFIG', `XiaoyiConfig 初始化完成: serviceUrl=${XIAOYI_CONFIG.serviceUrl || '(空)'}, uid=${XIAOYI_CONFIG.uid || '(空)'}, apiKey=${XIAOYI_CONFIG.apiKey ? '******' : '(空)'}`);
}

// Runtime 标识
const RUNTIME_ID =  'openclaw'; // 'openclaw' 或 'jiuwenclaw'

// Skill 根目录
const SKILLS_ROOTS = [
  path.join(os.homedir(), '.openclaw', 'workspace', 'skills'),
  path.join(os.homedir(), '.jiuwenclaw', 'workspace', 'agent', 'skills'),
];

// ============ 辅助函数 ============

function getCacheKey(pluginId: string, toolName: string): string {
  return `${pluginId}__${toolName}`;
}

function generateError(
  code: string,
  message: string,
  retryable: boolean = false,
  detail?: any
): ErrorResponse {
  return {
    ok: false,
    data: null,
    error: {
      code,
      message,
      retryable,
      detail,
    },
  };
}

function generateSuccess(data: any): SuccessResponse {
  return {
    ok: true,
    data,
    error: null,
  };
}

// [FIX #1] 函数签名改用 `arguments` 字段，与 ToolDefinition 保持一致
function validateArguments(
  args: Record<string, any>,
  schema: ToolDefinition['arguments']
): ErrorResponse | null {
  // 检查必填字段
  for (const requiredField of schema.required) {
    if (args[requiredField] === undefined || args[requiredField] === null) {
      return generateError(
        'INVALID_PARAM',
        `缺少必填参数: ${requiredField}`,
        false,
        { requiredField }
      );
    }
  }

  // 简单类型检查
  for (const [key, value] of Object.entries(args)) {
    if (schema.properties[key]) {
      const propType = schema.properties[key].type;
      const actualType = typeof value;

      if (propType === 'string' && actualType !== 'string') {
        return generateError(
          'INVALID_PARAM',
          `参数 ${key} 类型错误，期望 string，实际 ${actualType}`,
          false,
          { key, expected: 'string', actual: actualType }
        );
      }

      if (propType === 'number' && actualType !== 'number') {
        return generateError(
          'INVALID_PARAM',
          `参数 ${key} 类型错误，期望 number，实际 ${actualType}`,
          false,
          { key, expected: 'number', actual: actualType }
        );
      }

      if (propType === 'boolean' && actualType !== 'boolean') {
        return generateError(
          'INVALID_PARAM',
          `参数 ${key} 类型错误，期望 boolean，实际 ${actualType}`,
          false,
          { key, expected: 'boolean', actual: actualType }
        );
      }
    }
  }

  return null;
}

// ============ 工具定义比较 ============

function areToolsEqual(tool1: ToolDefinition, tool2: ToolDefinition): boolean {
  // [FIX #2] 核心字段列表中 'args' 改为 'arguments'，与 Readme §2.2 规范对齐
  const coreFields: (keyof ToolDefinition)[] = [
    'pluginId',
    'toolName',
    'toolType',
    'pluginType',
    'protocol',
    'description',
    'arguments',
    'deviceCommand',
  ];

  for (const field of coreFields) {
    if (JSON.stringify(tool1[field]) !== JSON.stringify(tool2[field])) {
      return false;
    }
  }

  return true;
}

// ============ 扫描 skills ============

async function parseSkillMetadata(skillPath: string): Promise<SkillMetadata | null> {
  try {
    const skillMdPath = path.join(skillPath, 'SKILL.md');
    const content = await fs.readFile(skillMdPath, 'utf-8');

    // 解析 frontmatter (YAML)
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      console.error(`No frontmatter found in ${skillMdPath}`);
      return null;
    }

    const frontmatter = frontmatterMatch[1];
    const metadata: any = {};

    // 简单 YAML 解析（生产环境应使用 yaml 库）
    const lines = frontmatter.split('\n');
    let currentKey = '';

    for (const line of lines) {
      if (line.includes(':')) {
        const [key, ...valueParts] = line.split(':');
        const value = valueParts.join(':').trim();
        currentKey = key.trim();

        if (currentKey === 'metadata') {
          metadata[currentKey] = {};
        } else if (currentKey === 'tools' && metadata.metadata) {
          // 复杂解析，这里简化处理
        } else if (currentKey === 'name') {
          metadata[currentKey] = value;
        } else if (currentKey === 'description') {
          metadata[currentKey] = value;
        } else if (currentKey === 'allowed-tools') {
          metadata[currentKey] = value;
        }
      }
    }

    // 提取 metadata.tools
    const toolsMatch = frontmatter.match(/tools:\n((?:\s+-.*\n)*)/);
    if (toolsMatch && metadata.metadata) {
      metadata.metadata.tools = [];
      const toolsLines = toolsMatch[1].split('\n');
      let currentTool: any = {};

      for (const line of toolsLines) {
        const pluginIdMatch = line.match(/pluginId:\s*(.+)/);
        const toolNameMatch = line.match(/toolName:\s*(.+)/);

        if (pluginIdMatch) {
          currentTool = {};
          currentTool.pluginId = pluginIdMatch[1].trim();
        }
        if (toolNameMatch && currentTool.pluginId) {
          currentTool.toolName = toolNameMatch[1].trim();
          metadata.metadata.tools.push(currentTool);
          currentTool = {};
        }
      }
    }

    return metadata as SkillMetadata;
  } catch (error) {
    console.error(`Failed to parse SKILL.md at ${skillPath}:`, error);
    return null;
  }
}

async function loadToolDefinition(toolFilePath: string): Promise<ToolDefinition | null> {
  try {
    log('DEBUG', 'SCAN', `加载工具定义: ${toolFilePath}`);
    const content = await fs.readFile(toolFilePath, 'utf-8');
    const toolDef = JSON.parse(content) as ToolDefinition;

    // [FIX #1] 验证必填字段时改用 `arguments` 而非 `args`
    if (!toolDef.schemaVersion || !toolDef.pluginId || !toolDef.toolName ||
        !toolDef.pluginType || !toolDef.description || !toolDef.arguments) {
      log('ERROR', 'SCAN', `工具定义缺少必填字段，跳过: ${toolFilePath}`, {
        hasSchemaVersion: !!toolDef.schemaVersion,
        hasPluginId: !!toolDef.pluginId,
        hasToolName: !!toolDef.toolName,
        hasPluginType: !!toolDef.pluginType,
        hasDescription: !!toolDef.description,
        hasArguments: !!toolDef.arguments,
      });
      return null;
    }

    // 验证 pluginType 相关的字段
    if ((toolDef.pluginType === 'Cloud' || toolDef.pluginType === 'MCP') &&
        !toolDef.protocol) {
      log('ERROR', 'SCAN', `Cloud/MCP 工具缺少 protocol 字段: ${toolFilePath}`);
      return null;
    }

    if (toolDef.pluginType === 'Device' && !toolDef.deviceCommand) {
      log('ERROR', 'SCAN', `Device 工具缺少 deviceCommand 字段: ${toolFilePath}`);
      return null;
    }

    log('DEBUG', 'SCAN', `工具定义加载成功: ${toolDef.pluginId}/${toolDef.toolName} [${toolDef.pluginType}]`);
    return toolDef;
  } catch (error) {
    log('ERROR', 'SCAN', `解析工具定义文件失败: ${toolFilePath}`, error);
    return null;
  }
}

// [FIX #7] 目录 mtime 缓存，用于检测 skills 目录变化并触发重新扫描
const dirMtimeCache: Map<string, number> = new Map();

async function hasDirectoryChanged(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    const mtime = stat.mtimeMs;
    const cached = dirMtimeCache.get(dirPath);
    if (cached === undefined || cached !== mtime) {
      dirMtimeCache.set(dirPath, mtime);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function scanSkills(): Promise<void> {
  log('INFO', 'SCAN', `开始扫描 skills，根目录: ${JSON.stringify(SKILLS_ROOTS)}`);
  const scanStart = Date.now();
  const newToolCache: ToolCache = {};
  const newSkillsMap: Map<string, SkillInfo> = new Map();
  // [FIX #5] 每次全量扫描时重置冲突集合
  conflictedKeys.clear();

  for (const root of SKILLS_ROOTS) {
    try {
      await fs.access(root);
    } catch {
      log('DEBUG', 'SCAN', `根目录不存在，跳过: ${root}`);
      continue; // 目录不存在，跳过
    }

    const skillDirs = await fs.readdir(root);
    log('INFO', 'SCAN', `发现 ${skillDirs.length} 个子目录: ${root}`);

    for (const skillDir of skillDirs) {
      const skillPath = path.join(root, skillDir);
      const stat = await fs.stat(skillPath);

      if (!stat.isDirectory()) continue;

      // 解析 SKILL.md
      const metadata = await parseSkillMetadata(skillPath);
      if (!metadata) {
        log('WARN', 'SCAN', `无法解析 SKILL.md，跳过: ${skillPath}`);
        continue;
      }

      log('DEBUG', 'SCAN', `已加载 skill: ${metadata.name} (${skillPath})`);
      newSkillsMap.set(metadata.name, {
        name: metadata.name,
        path: skillPath,
        metadata,
      });

      // 加载 tools
      const toolsDir = path.join(skillPath, 'references', 'tools');
      try {
        await fs.access(toolsDir);
      } catch {
        log('DEBUG', 'SCAN', `tools 目录不存在，跳过: ${toolsDir}`);
        continue;
      }

      const toolFiles = await fs.readdir(toolsDir);
      log('DEBUG', 'SCAN', `skill [${metadata.name}] 发现 ${toolFiles.length} 个工具文件`);

      for (const toolFile of toolFiles) {
        if (!toolFile.endsWith('.json')) continue;

        const toolPath = path.join(toolsDir, toolFile);
        const toolDef = await loadToolDefinition(toolPath);

        if (!toolDef) continue;

        const key = getCacheKey(toolDef.pluginId, toolDef.toolName);

        // [FIX #5] 检测冲突：不一致则记录到 conflictedKeys，调用时会返回 TOOL_CONFLICT
        if (newToolCache[key]) {
          if (!areToolsEqual(newToolCache[key], toolDef)) {
            log('ERROR', 'SCAN', `工具定义冲突: ${key}，已标记为 TOOL_CONFLICT`, {
              existing: { pluginId: newToolCache[key].pluginId, toolName: newToolCache[key].toolName },
              incoming: { pluginId: toolDef.pluginId, toolName: toolDef.toolName, path: toolPath },
            });
            conflictedKeys.add(key);
          } else {
            log('DEBUG', 'SCAN', `工具定义重复但一致，去重跳过: ${key}`);
          }
          // 一致则去重，不重复写入
        } else {
          newToolCache[key] = toolDef;
          log('DEBUG', 'SCAN', `工具已加入缓存: ${key} [${toolDef.pluginType}/${toolDef.protocol ?? 'N/A'}]`);
        }
      }
    }
  }

  toolCache = newToolCache;
  skillsMap = newSkillsMap;
  const elapsed = Date.now() - scanStart;
  log('INFO', 'SCAN', `扫描完成: ${skillsMap.size} 个 skill，${Object.keys(toolCache).length} 个工具，${conflictedKeys.size} 个冲突，耗时 ${elapsed}ms`);
}

// 懒刷新检查
let lastScanTime = 0;
async function lazyRefresh(): Promise<void> {
  const now = Date.now();

  // [FIX #7] 除定时检查外，还检测 skills 目录的 mtime 是否发生变化
  let directoryChanged = false;
  for (const root of SKILLS_ROOTS) {
    if (await hasDirectoryChanged(root)) {
      log('INFO', 'REFRESH', `检测到目录变更，触发重新扫描: ${root}`);
      directoryChanged = true;
      break;
    }
  }

  const timeSinceScan = now - lastScanTime;
  const timedOut = timeSinceScan > 300000;
  if (timedOut) {
    log('INFO', 'REFRESH', `缓存超时（已 ${Math.round(timeSinceScan / 1000)}s），触发重新扫描`);
  }

  if (directoryChanged || timedOut) {
    await scanSkills();
    lastScanTime = now;
  } else {
    log('DEBUG', 'REFRESH', `缓存有效（${Math.round(timeSinceScan / 1000)}s 前扫描），跳过`);
  }
}

// ============ Cloud/MCP 执行 ============

async function executeCloudTool(
  toolDef: ToolDefinition,
  pluginId: string,
  toolName: string,
  args: Record<string, any>
): Promise<ToolResponse> {
  log('INFO', 'CLOUD', `开始执行 Cloud/MCP 工具: ${pluginId}/${toolName} [${toolDef.protocol}]`, { args });

  // 检查配置
  if (!XIAOYI_CONFIG.serviceUrl || !XIAOYI_CONFIG.apiKey || !XIAOYI_CONFIG.uid) {
    const missing = ['SERVICE_URL', 'PERSONAL_API_KEY', 'PERSONAL_UID'].filter(
      key => !XIAOYI_CONFIG[key as keyof typeof XIAOYI_CONFIG]
    );
    log('ERROR', 'CLOUD', `配置缺失，无法执行: ${pluginId}/${toolName}`, { missing });
    return generateError(
      'CONFIG_MISSING',
      '缺少 Cloud/MCP 工具执行所需的配置',
      false,
      { missing }
    );
  }

  // 检查当前 skill 上下文
  if (!currentSkillName) {
    log('ERROR', 'CLOUD', `没有 skill 上下文，无法执行: ${pluginId}/${toolName}`);
    return generateError(
      'TOOL_NOT_FOUND',
      '没有选中的 skill 上下文',
      false,
      { pluginId, toolName }
    );
  }

  const endpoint = toolDef.protocol === 'SSE'
    ? `${XIAOYI_CONFIG.serviceUrl}/celia-claw/v1/sse-api/skill/execute`
    : `${XIAOYI_CONFIG.serviceUrl}/celia-claw/v1/rest-api/skill/execute`;

  log('DEBUG', 'CLOUD', `请求端点: ${endpoint}，skill 上下文: ${currentSkillName}`);

  // 构建请求体
  const traceId = XIAOYI_CONFIG.traceId();
  const requestBody: PluginExecutorRequest = {
    version: '1.0',
    session: {
      isNew: false,
      sessionId: `session-${Date.now()}`,
      interactionId: 0,
    },
    endpoint: {
      device: {
        sid: '',
        deviceId: '',
        prdVer: '',
        phoneType: '',
        sysVer: '',
        deviceType: 0,
        timezone: 'GMT+08:00',
      },
      locale: 'zh-CN',
      sysLocale: 'zh',
      countryCode: 'CN',
    },
    utterance: {
      type: 'text',
    },
    actions: [
      {
        actionSn: XIAOYI_CONFIG.traceId(),
        actionExecutorTask: {
          pluginId,
          agentState: 'OnShelf',
          actionName: toolName,
          content: args,
        },
      },
    ],
  };

  log('DEBUG', 'CLOUD', `请求体构建完成`, { traceId, sessionId: requestBody.session.sessionId, skillId: currentSkillName });

  // 发送请求
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-hag-trace-id': traceId,
      'x-uid': XIAOYI_CONFIG.uid,
      'x-api-key': XIAOYI_CONFIG.apiKey,
      'x-request-from': RUNTIME_ID,
      'x-skill-id': currentSkillName,
      'x-prd-pkg-name': 'com.huawei.hag',
    };

    if (toolDef.protocol === 'REST') {
      headers['Accept'] = 'application/json';
      log('INFO', 'CLOUD', `发送 REST 请求: ${endpoint}`, { traceId });

      const fetchStart = Date.now();
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });
      const elapsed = Date.now() - fetchStart;

      log('INFO', 'CLOUD', `REST 响应: status=${response.status}，耗时 ${elapsed}ms`, { traceId });

      if (!response.ok) {
        log('ERROR', 'CLOUD', `PluginExecutor 返回错误: ${response.status}`, { traceId, pluginId, toolName });
        return generateError(
          'UPSTREAM_ERROR',
          `PluginExecutor 返回错误: ${response.status}`,
          response.status >= 500,
          { status: response.status }
        );
      }

      const data = await response.json();
      log('DEBUG', 'CLOUD', `REST 响应数据`, data);
      log('INFO', 'CLOUD', `REST 工具执行成功: ${pluginId}/${toolName}`);
      return generateSuccess(data);
    } else if (toolDef.protocol === 'SSE') {
      headers['Accept'] = 'text/event-stream';
      log('INFO', 'CLOUD', `发送 SSE 请求: ${endpoint}`, { traceId });

      const fetchStart = Date.now();
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });
      const elapsed = Date.now() - fetchStart;

      log('INFO', 'CLOUD', `SSE 响应: status=${response.status}，耗时 ${elapsed}ms`, { traceId });

      if (!response.ok) {
        log('ERROR', 'CLOUD', `PluginExecutor SSE 返回错误: ${response.status}`, { traceId, pluginId, toolName });
        return generateError(
          'UPSTREAM_ERROR',
          `PluginExecutor 返回错误: ${response.status}`,
          response.status >= 500,
          { status: response.status }
        );
      }

      // [FIX #6] 处理 SSE 流：取所有有效 data 帧中的最后一条作为最终结果
      // Readme §4.5：忽略中间片段，只取最后完整结果
      const text = await response.text();
      const events = text.split('\n\n');
      log('DEBUG', 'CLOUD', `SSE 流接收完毕，共 ${events.length} 个事件帧`, { traceId });

      let lastData: any = null;
      let frameCount = 0;

      for (const event of events) {
        if (event.startsWith('data: ')) {
          const dataStr = event.substring(6).trim();
          if (!dataStr || dataStr === '[DONE]') {
            if (dataStr === '[DONE]') log('DEBUG', 'CLOUD', `SSE 收到 [DONE] 信号`);
            continue;
          }
          try {
            const data = JSON.parse(dataStr);
            frameCount++;
            log('DEBUG', 'CLOUD', `SSE 有效帧 #${frameCount}`, data);
            // 取最后一条有效 JSON 帧，不再依赖业务字段判断
            lastData = data;
          } catch {
            log('WARN', 'CLOUD', `SSE 帧 JSON 解析失败，跳过: ${dataStr.substring(0, 100)}`);
          }
        }
      }

      if (lastData !== null) {
        log('INFO', 'CLOUD', `SSE 工具执行成功: ${pluginId}/${toolName}，有效帧 ${frameCount} 个`);
        return generateSuccess(lastData);
      } else {
        log('ERROR', 'CLOUD', `SSE 流结束但无有效结果: ${pluginId}/${toolName}`, { traceId, streamPreview: text.substring(0, 200) });
        return generateError(
          'UPSTREAM_ERROR',
          'SSE 流结束但未返回有效结果',
          false,
          { streamContent: text.substring(0, 200) }
        );
      }
    }

    log('ERROR', 'CLOUD', `不支持的协议: ${toolDef.protocol}`);
    return generateError('UNSUPPORTED_PROTOCOL', `不支持的协议: ${toolDef.protocol}`, false);
  } catch (error) {
    log('ERROR', 'CLOUD', `网络请求异常: ${pluginId}/${toolName}`, error);
    return generateError(
      'NETWORK_ERROR',
      `网络错误: ${error instanceof Error ? error.message : String(error)}`,
      true
    );
  }
}

// ============ Device 执行 ============

function renderDeviceCommand(
  template: DeviceCommand['template'],
  args: Record<string, any>,
  schema: ToolDefinition['arguments']
): { rendered: DeviceCommand['template'] | null; error: ErrorResponse | null } {
  const rendered = JSON.parse(JSON.stringify(template));

  // [FIX #4] 占位符格式改为 #{arguments.xxx}，与 Readme §5.3 对齐
  function replacePlaceholders(obj: any): any {
    if (typeof obj === 'string') {
      const match = obj.match(/^#{arguments\.(\w+)}$/);
      if (match) {
        const argName = match[1];
        const value = args[argName];

        // Readme §5.3：缺失且为必填 → 返回 INVALID_PARAM；非必填则移除该字段
        if (value === undefined || value === null || value === '') {
          if (schema.required.includes(argName)) {
            // 用特殊标记触发错误，在外层处理
            return `__MISSING_REQUIRED__:${argName}`;
          }
          return '__REMOVE__';
        }
        return value;
      }
      return obj;
    } else if (Array.isArray(obj)) {
      return obj.map(item => replacePlaceholders(item)).filter(v => v !== '__REMOVE__');
    } else if (obj && typeof obj === 'object') {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        const replaced = replacePlaceholders(value);
        if (replaced !== '__REMOVE__') {
          result[key] = replaced;
        }
      }
      return result;
    }
    return obj;
  }

  const result = replacePlaceholders(rendered);

  // 检查是否存在缺失必填参数
  const resultStr = JSON.stringify(result);
  const missingMatch = resultStr.match(/"__MISSING_REQUIRED__:(\w+)"/);
  if (missingMatch) {
    return {
      rendered: null,
      error: generateError(
        'INVALID_PARAM',
        `Device 命令缺少必填参数: ${missingMatch[1]}`,
        false,
        { requiredField: missingMatch[1] }
      ),
    };
  }

  return { rendered: result, error: null };
}

// executeDeviceTool 持有的 call_device_tool 实例，由 createFunctionCallTool 在构造时注入
let callDeviceToolInstance: any = null;

/**
 * 注入 call_device_tool 实例，供 executeDeviceTool 内部使用。
 * 由 createFunctionCallTool(ctx) 在构造时调用，与 ctx 生命周期一致。
 */
export function setCallDeviceToolInstance(instance: any): void {
  callDeviceToolInstance = instance;
}

async function executeDeviceTool(
  toolDef: ToolDefinition,
  pluginId: string,
  toolName: string,
  args: Record<string, any>,
  toolCallId: string
): Promise<ToolResponse> {
  log('INFO', 'DEVICE', `开始执行 Device 工具: ${pluginId}/${toolName}`, { toolCallId, args });

  if (!toolDef.deviceCommand) {
    log('ERROR', 'DEVICE', `Device 工具缺少 deviceCommand 定义: ${pluginId}/${toolName}`);
    return generateError(
      'CONFIG_MISSING',
      'Device 工具缺少 deviceCommand 定义',
      false
    );
  }

  // 渲染端命令，目的是做参数校验（必填检查 + 可选字段剔除）
  // 渲染后的 renderedCommand 本身不直接下发，call_device_tool 内部会再次构建命令
  log('DEBUG', 'DEVICE', `渲染 deviceCommand 模板并校验参数: ${pluginId}/${toolName}`);
  const { error: renderError } = renderDeviceCommand(
    toolDef.deviceCommand.template,
    args,
    toolDef.arguments
  );
  if (renderError) {
    log('ERROR', 'DEVICE', `deviceCommand 渲染失败: ${pluginId}/${toolName}`, renderError);
    return renderError;
  }
  log('DEBUG', 'DEVICE', `deviceCommand 渲染校验通过: ${pluginId}/${toolName}`);

  if (!callDeviceToolInstance) {
    log('ERROR', 'DEVICE', `callDeviceToolInstance 未初始化，请通过 createFunctionCallTool 调用`);
    return generateError(
      'CONFIG_MISSING',
      'Device 工具执行缺少 call_device_tool 实例（未通过 createFunctionCallTool 调用）',
      false
    );
  }

  // 直接调用 call_device_tool.execute，复用其完整的
  // sendCommand + data-event 监听 + 超时 + 错误处理逻辑
  // 参数格式与 call_device_tool.parameters 定义完全一致：{ toolName, arguments }
  log('INFO', 'DEVICE', `调用 call_device_tool.execute: ${pluginId}/${toolName}`, { toolCallId });
  const execStart = Date.now();
  const result = await callDeviceToolInstance.execute(toolCallId, {
    toolName,
    arguments: args,
  });
  const elapsed = Date.now() - execStart;

  log('INFO', 'DEVICE', `Device 工具执行完毕: ${pluginId}/${toolName}，耗时 ${elapsed}ms`);
  log('DEBUG', 'DEVICE', `Device 执行结果`, result);
  return generateSuccess(result);
}

// ============ 主工具函数 ============

/**
 * 设置当前 skill 上下文（由运行时在调用 function_call_tool 前设置）
 */
export function setCurrentSkill(skillName: string | null): void {
  if (skillName !== currentSkillName) {
    log('DEBUG', 'CTX', `skill 上下文切换: ${currentSkillName ?? '(null)'} → ${skillName ?? '(null)'}`);
  }
  currentSkillName = skillName;
}

/**
 * 手动刷新工具缓存
 */
export async function refreshToolCache(): Promise<void> {
  log('INFO', 'CACHE', '手动触发工具缓存刷新');
  await scanSkills();
  log('INFO', 'CACHE', '工具缓存刷新完成');
}

/**
 * 工具执行入口
 */
export async function function_call_tool(params: {
  pluginId: string;
  toolName: string;
  // [FIX #3] 入参字段名改为 `arguments`，与 Readme §3.1 规范对齐
  arguments: Record<string, any>;
  toolCallId?: string;
}): Promise<ToolResponse> {
  const callId = params.toolCallId ?? `call-${Date.now()}`;
  log('INFO', 'CALL', `工具调用入口: ${params.pluginId}/${params.toolName}`, {
    toolCallId: callId,
    argumentKeys: params.arguments ? Object.keys(params.arguments) : [],
  });

  // 参数验证
  if (!params.pluginId || !params.toolName || !params.arguments) {
    log('ERROR', 'CALL', `缺少必要参数`, { received: Object.keys(params) });
    return generateError(
      'INVALID_PARAM',
      '缺少必要参数: pluginId, toolName, arguments',
      false,
      { received: Object.keys(params) }
    );
  }

  // 懒刷新缓存
  log('DEBUG', 'CALL', `检查缓存刷新: ${params.pluginId}/${params.toolName}`);
  await lazyRefresh();

  // 查找工具
  const cacheKey = getCacheKey(params.pluginId, params.toolName);

  // [FIX #5] 调用前检查是否存在冲突，有冲突直接返回 TOOL_CONFLICT
  if (conflictedKeys.has(cacheKey)) {
    log('ERROR', 'CALL', `工具存在冲突定义，拒绝执行: ${cacheKey}`);
    return generateError(
      'TOOL_CONFLICT',
      `工具 ${params.pluginId}/${params.toolName} 存在不一致的定义`,
      false,
      { pluginId: params.pluginId, toolName: params.toolName }
    );
  }

  const toolDef = toolCache[cacheKey];

  if (!toolDef) {
    log('ERROR', 'CALL', `工具未找到: ${cacheKey}，当前缓存工具: ${Object.keys(toolCache).join(', ') || '(空)'}`);
    return generateError(
      'TOOL_NOT_FOUND',
      `未找到工具: ${params.pluginId}/${params.toolName}`,
      false,
      { pluginId: params.pluginId, toolName: params.toolName }
    );
  }

  log('DEBUG', 'CALL', `工具已找到: ${cacheKey} [${toolDef.pluginType}]`);

  // [FIX #1] 使用 validateArguments 并访问 toolDef.arguments
  log('DEBUG', 'CALL', `校验入参: ${cacheKey}`, { args: params.arguments });
  const validationError = validateArguments(params.arguments, toolDef.arguments);
  if (validationError) {
    log('WARN', 'CALL', `入参校验失败: ${cacheKey}`, validationError);
    return validationError;
  }
  log('DEBUG', 'CALL', `入参校验通过: ${cacheKey}`);

  // 根据 pluginType 执行
  log('INFO', 'CALL', `分发执行: ${cacheKey} → ${toolDef.pluginType}`);
  switch (toolDef.pluginType) {
    case 'Cloud':
    case 'MCP':
      return await executeCloudTool(
        toolDef,
        params.pluginId,
        params.toolName,
        params.arguments
      );

    case 'Device':
      return await executeDeviceTool(
        toolDef,
        params.pluginId,
        params.toolName,
        params.arguments,
        params.toolCallId ?? ''
      );

    default:
      log('ERROR', 'CALL', `不支持的 pluginType: ${toolDef.pluginType}`, { cacheKey });
      return generateError(
        'UNSUPPORTED_PLUGIN_TYPE',
        `不支持的 pluginType: ${toolDef.pluginType}`,
        false,
        { pluginType: toolDef.pluginType }
      );
  }
}

// ============ 初始化 ============

// 启动时初始化配置并扫描 skills
initXiaoyiConfig().catch(console.error);
scanSkills().catch(console.error);

// 导出工具注册信息（用于 LLM）
// [FIX #3] 参数名改为 `arguments`，description 也同步更新
export const toolRegistration = {
  name: 'function_call_tool',
  description: '调用已安装 skill 中声明的工具。必须传 pluginId、toolName 和 arguments；pluginId 和 toolName 来自工具表；完整参数定义见 references/tools/<pluginId>__<toolName>.json。',
  parameters: {
    type: 'object',
    properties: {
      pluginId: {
        type: 'string',
        description: '插件实例 ID，如 plugin_001。',
      },
      toolName: {
        type: 'string',
        description: '插件内函数名，如 weather_query。',
      },
      arguments: {
        type: 'object',
        description: '工具参数，字段遵循对应 references/tools JSON 中的 arguments schema。',
        additionalProperties: true,
      },
    },
    required: ['pluginId', 'toolName', 'arguments'],
  },
};

// ============ XY Channel 集成 ============

/**
 * 创建适配 XY Channel SessionContext 的 function_call_tool 工具实例。
 *
 * 在每轮对话开始时由 create-all-tools.ts 调用，传入当前 SessionContext。
 * SessionContext 中的 agentId（即当前 skill 名称）会被设置为工具执行时的 skill 上下文，
 * 从而让 executeCloudTool 可以正确填写 x-skill-id 请求头。
 *
 * 内部实现逻辑（scanSkills、executeCloudTool、executeDeviceTool 等）保持不变，
 * 仅在 execute 入口处注入 SessionContext 信息。
 */
export function createFunctionCallTool(ctx: SessionContext): any {
  log('INFO', 'INIT', `createFunctionCallTool 初始化: agentId=${ctx.agentId ?? '(null)'}, sessionId=${ctx.sessionId ?? '(null)'}`);
  // 用同一个 ctx 构造 call_device_tool 实例，并注入供 executeDeviceTool 使用
  // 延迟 import 避免循环依赖：call-device-tool.ts 不依赖本文件
  import('./call-device-tool.js').then(({ createCallDeviceTool }) => {
    setCallDeviceToolInstance(createCallDeviceTool(ctx));
    log('INFO', 'INIT', `call_device_tool 实例注入完成: agentId=${ctx.agentId ?? '(null)'}`);
  });

  return {
    name: 'function_call_tool',
    label: 'Function Call Tool',
    description: toolRegistration.description,
    parameters: toolRegistration.parameters,

    async execute(toolCallId: string, params: any) {
      // 将 SessionContext 中的 agentId 作为当前 skill 上下文注入
      setCurrentSkill(ctx.agentId ?? null);
      log('INFO', 'EXECUTE', `createFunctionCallTool.execute 调用: ${params.pluginId}/${params.toolName}`, {
        toolCallId,
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        argumentKeys: params.arguments ? Object.keys(params.arguments) : [],
      });

      try {
        const result = await function_call_tool({
          pluginId: params.pluginId,
          toolName: params.toolName,
          // [FIX #3] 入参字段名改为 arguments
          arguments: params.arguments ?? {},
          toolCallId,
        });
        log('INFO', 'EXECUTE', `工具调用结束: ${params.pluginId}/${params.toolName}`, { ok: result.ok, toolCallId });
        return result;
      } finally {
        // 执行完毕后清理 skill 上下文，避免泄漏到其他工具调用
        log('DEBUG', 'EXECUTE', `清理 skill 上下文: ${ctx.agentId ?? '(null)'}`);
        setCurrentSkill(null);
      }
    },
  };
}
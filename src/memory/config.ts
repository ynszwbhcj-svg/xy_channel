import { isAbsolute } from "node:path";

export interface MemoryMcpConfig {
  backend: "mcp-http";
  endpoint: string;
  tokenFile: string;
}

export function validateMemoryEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value) {
    throw new Error("CELIA_MEMORY_HTTP_URL must be an explicit loopback MCP URL");
  }
  let url: URL;
  try { url = new URL(value); } catch {
    throw new Error("CELIA_MEMORY_HTTP_URL must be an explicit loopback MCP URL");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/mcp"
      || url.username || url.password || url.search || url.hash) {
    throw new Error("Memory MCP requires http://127.0.0.1:<port>/mcp without URL credentials or query");
  }
  return url.href;
}

export function resolveMemoryMcpConfig(value: unknown, env: NodeJS.ProcessEnv = process.env): MemoryMcpConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => key !== "backend")
      || (value as { backend?: unknown }).backend !== "mcp-http") {
    throw new Error("XY memory configuration must be { backend: 'mcp-http' }");
  }
  const tokenFile = env.CELIA_MEMORY_HTTP_TOKEN_FILE;
  if (!tokenFile || tokenFile.trim() !== tokenFile || !isAbsolute(tokenFile) || tokenFile.includes("\0")) {
    throw new Error("CELIA_MEMORY_HTTP_TOKEN_FILE must be an absolute private token file path");
  }
  return { backend: "mcp-http", endpoint: validateMemoryEndpoint(env.CELIA_MEMORY_HTTP_URL), tokenFile };
}

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { request } from "node:http";
import type { MemoryMcpConfig } from "./config.js";
import { validateMemoryEndpoint } from "./config.js";

export type ProfileMethod = "memory.profile.settings.get" | "memory.profile.settings.set"
  | "memory.profile.get" | "memory.profile.modify" | "memory.profile.reset" | "memory.profile.reset.status";
export interface ProfileReceipt { status: number; result: Record<string, any> | null }
export type MemoryFailureKind = "configuration" | "unavailable" | "rejected" | "unknown";

export class MemoryMcpError extends Error {
  constructor(readonly kind: MemoryFailureKind, readonly errorCode: string, message: string) {
    super(message);
    this.name = "MemoryMcpError";
  }
}

export function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;

async function readToken(path: string): Promise<string> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      const uid = process.getuid?.();
      if (!stat.isFile() || (stat.mode & 0o077) || stat.size < 64 || stat.size > 66
          || (uid !== undefined && uid !== 0 && stat.uid !== uid)) throw new Error();
      const buffer = Buffer.alloc(67);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const token = buffer.subarray(0, bytesRead).toString("utf8").replace(/\r?\n$/, "");
      if (!/^[a-fA-F0-9]{64}$/.test(token)) throw new Error();
      return token;
    } finally { await file.close(); }
  } catch {
    throw new MemoryMcpError("configuration", "MCP_TOKEN_INVALID", "Memory MCP requires a readable owner-private regular token file");
  }
}

/** Stateless, direct loopback HTTP: no proxy, redirects, reconnect replay or write retry. */
export class MemoryMcpClient {
  private readyPromise?: Promise<void>;
  private readonly endpoint: string;
  private readonly limits: { requestMs: number; probeMs: number; connectMs: number };

  constructor(private readonly config: MemoryMcpConfig,
              limits: Partial<{ requestMs: number; probeMs: number; connectMs: number }> = {}) {
    this.endpoint = validateMemoryEndpoint(config.endpoint);
    this.limits = { requestMs: 30_000, probeMs: 5_000, connectMs: 3_000, ...limits };
  }

  private async rpc(method: string, params: Record<string, unknown>, timeoutMs: number, requestId?: string): Promise<Record<string, any>> {
    const id = randomUUID();
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params,
      ...(requestId ? { request_id: requestId } : {}) }));
    if (body.length > MAX_REQUEST_BYTES) {
      throw new MemoryMcpError("rejected", "MCP_REQUEST_TOO_LARGE", "Memory request exceeds 64 KiB");
    }
    const token = await readToken(this.config.tokenFile);
    return new Promise((resolve, reject) => {
      let settled = false;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      const unknown = () => new MemoryMcpError("unknown", "MCP_OUTCOME_UNKNOWN", "Memory request outcome is unknown; do not resend mutations");
      const finish = (error?: MemoryMcpError, result?: Record<string, any>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearTimeout(connectTimer);
        if (error) reject(error); else resolve(result!);
      };
      const req = request(this.endpoint, {
        method: "POST", agent: false,
        headers: { "Content-Type": "application/json", "Content-Length": body.length, Authorization: `Bearer ${token}` },
      }, res => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) { finish(unknown()); res.destroy(); req.destroy(); }
          else chunks.push(chunk);
        });
        res.on("error", () => finish(unknown()));
        res.on("aborted", () => finish(unknown()));
        res.on("end", () => {
          if (settled) return;
          if (res.statusCode === 401 || res.statusCode === 403) {
            finish(new MemoryMcpError("rejected", "MCP_AUTH_REJECTED", "Memory service rejected authentication")); return;
          }
          if (res.statusCode !== 200 || res.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
            finish(unknown()); return;
          }
          let envelope: any;
          try { envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { finish(unknown()); return; }
          if (!isRecord(envelope) || envelope.jsonrpc !== "2.0" || envelope.id !== id
              || "error" in envelope || !isRecord(envelope.result)) { finish(unknown()); return; }
          finish(undefined, envelope.result);
        });
      });
      const timer = setTimeout(() => { finish(unknown()); req.destroy(); }, timeoutMs);
      req.on("socket", socket => {
        if (!socket.connecting) return;
        connectTimer = setTimeout(() => { finish(unknown()); req.destroy(); }, this.limits.connectMs);
        socket.once("connect", () => clearTimeout(connectTimer));
      });
      req.on("error", () => finish(unknown()));
      req.end(body);
    });
  }

  private ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        const hello = await this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {},
          clientInfo: { name: "xy-channel-memory", version: "1" } }, this.limits.probeMs);
        if (hello.protocolVersion !== "2025-03-26") throw new Error();
        const settings = await this.rpc("memory.profile.settings.get", {}, this.limits.probeMs);
        // A reset can legitimately make settings.get Busy. Do not prevent the
        // independent reset.status query from recovering a timed-out reset.
        if (!(settings.status === -5 && settings.result === null)
            && (settings.status !== 0 || !isRecord(settings.result) || typeof settings.result.enabled !== "boolean")) throw new Error();
      })().catch(error => {
        this.readyPromise = undefined;
        if (error instanceof MemoryMcpError && error.kind === "configuration") throw error;
        throw new MemoryMcpError("unavailable", "MCP_UNAVAILABLE", "Memory service did not pass its read-only startup probe; business request was not sent");
      });
    }
    return this.readyPromise;
  }

  async callProfile(method: ProfileMethod, params: Record<string, unknown>, requestId?: string): Promise<ProfileReceipt> {
    await this.ready();
    try {
      const receipt = await this.rpc(method, params, this.limits.requestMs, requestId);
      if (!Number.isInteger(receipt.status) || receipt.status < -2147483648 || receipt.status > 2147483647
          || !("result" in receipt) || (receipt.result !== null && !isRecord(receipt.result))) {
        throw new MemoryMcpError("unknown", "MCP_INVALID_RECEIPT", "Memory business receipt is invalid");
      }
      return receipt as ProfileReceipt;
    } catch (error) {
      this.readyPromise = undefined;
      throw error;
    }
  }
}

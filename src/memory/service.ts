import { createHash, randomUUID } from "node:crypto";
import type { MemoryMcpConfig } from "./config.js";
import { isRecord, MemoryMcpClient, MemoryMcpError, type ProfileMethod, type ProfileReceipt } from "./mcp-http-client.js";
import { MEMORY_ANSWER_BUDGET, memoryAnswerBytes, MemoryViewError, MemoryViews } from "./view.js";

export const MCP_MEMORY_ACTIONS = new Set([
  "MemoryStateGet", "MemoryStateSet", "UserMdQuery", "MemoryMdQuery",
  "MemoryProfileModify", "MemoryReset", "MemoryResetStatus",
]);
export const NEW_MEMORY_ACTIONS = new Set(["MemoryProfileModify", "MemoryReset", "MemoryResetStatus"]);
export interface MemoryContext { action: string; params?: unknown; sessionId?: string; messageId?: string | number }
export type MemoryAnswer = Record<string, any>;

class InvalidRequest extends Error {}
function ensure(value: unknown): asserts value {
  if (!value) throw new InvalidRequest();
}
function paramsOf(value: unknown): Record<string, any> {
  if (value === undefined) return {};
  ensure(isRecord(value));
  if (!("body" in value)) return value;
  ensure(Object.keys(value).length === 1 && isRecord(value.body));
  return value.body;
}
function only(value: Record<string, any>, names: string[]): void {
  ensure(Object.keys(value).every(key => names.includes(key)));
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 255
    && !/[\u0000-\u001f\u007f]/.test(value) && Buffer.from(value).toString("utf8") === value;
}
function failed(requestId: string | undefined, errorCode: string, outcome = "failed", nativeStatus?: number,
                result?: Record<string, any> | null): MemoryAnswer {
  return { ok: false, code: nativeStatus !== undefined && nativeStatus < 0 ? nativeStatus : -1,
    ...(requestId ? { requestId } : {}), outcome, errorCode,
    ...(nativeStatus !== undefined ? { nativeStatus } : {}), ...(result !== undefined ? { result } : {}) };
}
function validAtomIds(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every(id =>
    typeof id === "string" && /^[1-9][0-9]{0,19}$/.test(id) && BigInt(id) <= 18446744073709551615n);
}

export class MemoryService {
  private readonly views = new MemoryViews();
  private viewRevision = 0;
  private readonly writes = new Map<string, { fingerprint: string; answer: Promise<MemoryAnswer>; until?: number }>();
  constructor(private readonly client: Pick<MemoryMcpClient, "callProfile">, private readonly account: string) {}

  private requestId(context: MemoryContext, params: Record<string, any>, mutation: boolean): string {
    if ("requestId" in params) { ensure(validId(params.requestId)); return params.requestId; }
    if (context.messageId !== undefined) {
      ensure((typeof context.messageId === "string" || typeof context.messageId === "number")
        && (typeof context.messageId !== "number" || Number.isSafeInteger(context.messageId))
        && String(context.messageId).length > 0 && String(context.messageId).length <= 4096);
      return "xy-" + createHash("sha256").update(JSON.stringify([
        this.account, context.sessionId ?? "", context.action, context.messageId,
      ])).digest("hex").slice(0, 40);
    }
    ensure(!mutation);
    return randomUUID();
  }

  private classify(action: string, receipt: ProfileReceipt, requestId: string, desired?: boolean): MemoryAnswer {
    const { status, result } = receipt;
    if ((action === "MemoryStateGet" || action === "MemoryStateSet") && result?.recoveryRequired === true) {
      return { ...failed(requestId, "MEMORY_RECOVERY_REQUIRED", "recovery_required", status, result),
        ...(typeof result.enabled === "boolean" ? { memoryState: result.enabled } : {}) };
    }
    if (status !== 0) {
      const details = result ?? {};
      const partial = details.storeCompleted === true || (details.failedRows > 0
        && ["memoryRows", "stateRows", "indexRows", "securityRows"].some(key => details[key] > 0));
      return failed(requestId, "MCP_BUSINESS_FAILURE", status === -5 ? "busy" : partial ? "partial" : "failed", status, result);
    }
    if (!isRecord(result)) return failed(requestId, "MCP_INVALID_RECEIPT", "unknown", status);
    if (result.skipped === true) return failed(requestId, "MEMORY_DISABLED", "skipped", status, result);
    const answer = { ok: true, code: 0, requestId, nativeStatus: status, outcome: "succeeded", result };
    if (action === "MemoryStateGet" || action === "MemoryStateSet") {
      if (typeof result.enabled !== "boolean"
          || (action === "MemoryStateSet" && (result.enabled !== desired || result.applied !== true || result.persisted !== true))) {
        return failed(requestId, "MCP_INVALID_RECEIPT", "unknown", status, result);
      }
      return { ...answer, memoryState: result.enabled };
    }
    if (action === "MemoryProfileModify") {
      if (result.storeCompleted !== true || result.triggerAttempted !== true || result.triggerCompleted !== true
          || !validAtomIds(result.atomIds)) return failed(requestId, "MCP_INCOMPLETE_EDIT", "unknown", status, result);
    }
    if (action === "MemoryReset") {
      const counts = ["memoryRows", "stateRows", "indexRows", "securityRows", "failedRows"];
      if (typeof result.dryRun !== "boolean" || typeof result.coreClearCompleted !== "boolean"
          || typeof result.cloudSummaryResetRequired !== "boolean"
          || counts.some(key => !Number.isSafeInteger(result[key]) || result[key] < 0) || result.failedRows !== 0) {
        return failed(requestId, "MCP_INVALID_RESET_RECEIPT", "unknown", status, result);
      }
      if (result.dryRun) {
        return result.coreClearCompleted ? failed(requestId, "MCP_INVALID_RESET_RECEIPT", "unknown", status, result)
          : { ...answer, outcome: "preview" };
      }
      if (!result.coreClearCompleted) return failed(requestId, "MCP_INCOMPLETE_RESET", "unknown", status, result);
      if (result.cloudSummaryResetRequired) return failed(requestId, "FUSION_RESET_REQUIRED", "sync_required", status, result);
    }
    return answer;
  }

  private async invoke(action: string, method: ProfileMethod, params: Record<string, unknown>, requestId: string,
                       desired?: boolean): Promise<MemoryAnswer> {
    try { return this.classify(action, await this.client.callProfile(method, params, requestId), requestId, desired); }
    catch (error) {
      if (error instanceof MemoryMcpError) return failed(requestId, error.errorCode, error.kind);
      return failed(requestId, "MCP_OUTCOME_UNKNOWN", "unknown");
    }
  }

  private async mutate(context: MemoryContext, params: Record<string, any>, method: ProfileMethod,
                       args: Record<string, unknown>, desired?: boolean): Promise<MemoryAnswer> {
    const id = this.requestId(context, params, true);
    const fingerprint = JSON.stringify([context.action, context.sessionId ?? "", method, args]);
    const now = Date.now();
    for (const [key, value] of this.writes) if (value.until !== undefined && value.until < now) this.writes.delete(key);
    const old = this.writes.get(id);
    if (old) return old.fingerprint === fingerprint ? old.answer : failed(id, "REQUEST_ID_CONFLICT", "rejected");
    if (this.writes.size >= 64) return failed(id, "MEMORY_ADMISSION_BUSY", "busy");
    this.views.clear();
    this.viewRevision++;
    const entry = { fingerprint, answer: undefined as unknown as Promise<MemoryAnswer>, until: undefined as number | undefined };
    entry.answer = this.invoke(context.action, method, args, id, desired).finally(() => {
      entry.until = Date.now() + 5 * 60_000;
      this.views.clear();
      this.viewRevision++;
    });
    this.writes.set(id, entry);
    return entry.answer;
  }

  private async view(context: MemoryContext, params: Record<string, any>): Promise<MemoryAnswer> {
    only(params, ["requestId", "snapshotId", "offset", ...(context.action === "MemoryMdQuery" ? ["section"] : [])]);
    const section = context.action === "UserMdQuery" ? "userMd" : params.section ?? "memoryMd";
    ensure(context.action === "UserMdQuery" ? section === "userMd" : section === "memoryMd" || section === "cloudGlobalSummary");
    const offset = params.offset ?? 0;
    ensure(Number.isSafeInteger(offset) && offset >= 0);
    const session = context.sessionId ?? "";
    const id = this.requestId(context, params, false);
    let snapshot = params.snapshotId;
    if (snapshot !== undefined) ensure(validId(snapshot));
    else {
      ensure(offset === 0);
      const revision = this.viewRevision;
      const receipt = await this.client.callProfile("memory.profile.get", session ? { session_id: session } : {}, id);
      if (revision !== this.viewRevision) throw new MemoryViewError("SNAPSHOT_EXPIRED");
      if (receipt.status !== 0) return failed(id, "MCP_BUSINESS_FAILURE", receipt.status === -5 ? "busy" : "failed", receipt.status, receipt.result);
      const value = receipt.result;
      if (!isRecord(value) || !["ok", "not_found"].includes(value.status) || !isRecord(value.payload)
          || typeof value.payload.userMd !== "string" || typeof value.payload.memoryMd !== "string"
          || (value.payload.cloudGlobalSummary !== undefined && typeof value.payload.cloudGlobalSummary !== "string")) {
        return failed(id, "MCP_INVALID_PROFILE", "unknown", receipt.status);
      }
      const skipped = value.skipped === true || value.meta?.skipped === true;
      snapshot = this.views.put(session, { userMd: value.payload.userMd, memoryMd: value.payload.memoryMd,
        cloudGlobalSummary: value.payload.cloudGlobalSummary ?? "" }, {
        outcome: skipped ? "skipped" : "succeeded", skipped, memoryEnabled: !skipped,
        cloudSummaryAvailable: !!value.payload.cloudGlobalSummary, cloudSummaryFile: value.meta?.cloudSummaryFile ?? null,
      });
    }
    return this.views.page(snapshot, session, section, offset, { ok: true, code: 0, nativeStatus: 0, requestId: id });
  }

  async handle(context: MemoryContext): Promise<MemoryAnswer> {
    let answer: MemoryAnswer;
    let correlationId: string | undefined;
    try {
      const params = paramsOf(context.params);
      if (validId(params.requestId)) correlationId = params.requestId;
      if (context.sessionId !== undefined) ensure(validId(context.sessionId));
      switch (context.action) {
        case "MemoryStateGet": {
          only(params, ["requestId"]);
          answer = await this.invoke(context.action, "memory.profile.settings.get", {}, this.requestId(context, params, false)); break;
        }
        case "MemoryStateSet":
          only(params, ["requestId", "memoryState"]); ensure(typeof params.memoryState === "boolean");
          answer = await this.mutate(context, params, "memory.profile.settings.set", { enabled: params.memoryState }, params.memoryState); break;
        case "UserMdQuery": case "MemoryMdQuery": answer = await this.view(context, params); break;
        case "MemoryProfileModify":
          only(params, ["requestId", "instruction"]);
          ensure(validId(context.sessionId) && typeof params.instruction === "string" && params.instruction.trim().length > 0
            && Buffer.byteLength(params.instruction, "utf8") <= 8192 && !params.instruction.includes("\0")
            && Buffer.from(params.instruction).toString("utf8") === params.instruction);
          answer = await this.mutate(context, params, "memory.profile.modify", { instruction: params.instruction, session_id: context.sessionId }); break;
        case "MemoryReset":
          only(params, ["requestId", "dryRun"]); ensure(params.dryRun === undefined || typeof params.dryRun === "boolean");
          answer = await this.mutate(context, params, "memory.profile.reset", { dry_run: params.dryRun ?? false }); break;
        case "MemoryResetStatus": {
          only(params, ["requestId"]); ensure(validId(params.requestId));
          const receipt = await this.client.callProfile("memory.profile.reset.status", { request_id: params.requestId }, randomUUID());
          const value = receipt.result;
          if (receipt.status !== 0) answer = failed(params.requestId, "MCP_BUSINESS_FAILURE", receipt.status === -5 ? "busy" : "failed", receipt.status, value);
          else if (!isRecord(value) || value.requestId !== params.requestId
              || !["not_found", "running", "succeeded", "failed", "unknown"].includes(value.state)) {
            answer = failed(params.requestId, "MCP_INVALID_RESET_STATE", "unknown");
          } else if (value.state === "running") {
            answer = { ok: true, code: 0, requestId: params.requestId, outcome: "running", state: value.state, result: value };
          } else if (value.state === "not_found" || value.state === "unknown") {
            answer = { ...failed(params.requestId, "RESET_OUTCOME_UNKNOWN", "unknown", 0, value), state: value.state };
          } else if (!isRecord(value.response) || !Number.isInteger(value.response.status)
              || !(value.response.result === null || isRecord(value.response.result))
              || (value.state === "succeeded") !== (value.response.status === 0)) {
            answer = failed(params.requestId, "MCP_INVALID_RESET_STATE", "unknown");
          } else {
            answer = { ...this.classify("MemoryReset", value.response as ProfileReceipt, params.requestId), state: value.state, response: value.response };
          }
          break;
        }
        default: answer = failed(undefined, "MEMORY_ACTION_UNSUPPORTED", "rejected");
      }
    } catch (error) {
      if (error instanceof InvalidRequest) answer = failed(correlationId, "INVALID_REQUEST", "rejected");
      else if (error instanceof MemoryViewError) answer = failed(correlationId, error.errorCode, "rejected");
      else if (error instanceof MemoryMcpError) answer = failed(correlationId, error.errorCode, error.kind);
      else answer = failed(correlationId, "MCP_OUTCOME_UNKNOWN", "unknown");
    }
    return memoryAnswerBytes(answer) <= MEMORY_ANSWER_BUDGET ? answer
      : failed(answer.requestId, "RESPONSE_TOO_LARGE", "unknown", answer.nativeStatus);
  }
}

const services = new WeakMap<object, { key: string; service: MemoryService }>();
export function memoryServiceFor(owner: object, config: MemoryMcpConfig, account: string): MemoryService {
  const key = JSON.stringify([config, account]);
  let cached = services.get(owner);
  if (!cached || cached.key !== key) {
    cached = { key, service: new MemoryService(new MemoryMcpClient(config), account) };
    services.set(owner, cached);
  }
  return cached.service;
}

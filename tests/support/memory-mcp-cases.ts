import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, writeFile, chmod, symlink, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolveMemoryMcpConfig } from "../../src/memory/config.js";
import { MemoryMcpClient } from "../../src/memory/mcp-http-client.js";
import { MemoryService } from "../../src/memory/service.js";
import { MemoryViews, memoryAnswerBytes } from "../../src/memory/view.js";
import { hasMemoryQueryFrame, memoryAnswerSummary, preserveMemoryDisplay } from "../../src/memory/command.js";

const TOKEN = "a".repeat(64);
const profile = { status: "ok", payload: { userMd: "private user profile", memoryMd: "private memory",
  cloudGlobalSummary: "private fused summary" }, meta: { cloudSummaryFile: { status: "ok" } } };
const edited = { atomIds: ["9223372036854775931"], storeCompleted: true, triggerAttempted: true, triggerCompleted: true };
function resetReceipt(dryRun = false, fusion = false) {
  return { dryRun, coreClearCompleted: !dryRun, cloudSummaryResetRequired: fusion,
    memoryRows: 1, stateRows: 2, indexRows: 3, securityRows: 0, failedRows: 0 };
}
function reply(res: ServerResponse, request: any, result: any, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
}
async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) { assert(Date.now() < end, "fixture did not receive request"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fixture(run: (f: any) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "xy-memory-mcp-"));
  const tokenFile = join(directory, "token");
  await writeFile(tokenFile, TOKEN + "\n", { mode: 0o600 });
  const f: any = { directory, tokenFile, calls: [], enabled: true, profile: structuredClone(profile), route: undefined };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", async () => {
      const request = JSON.parse(Buffer.concat(chunks).toString());
      f.calls.push(request);
      assert.equal(req.url, "/mcp");
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      assert(!JSON.stringify(request).includes(TOKEN), "credential must remain in HTTP header");
      if (await f.route?.(request, res)) return;
      if (request.method === "initialize") reply(res, request, { protocolVersion: "2025-03-26" });
      else if (request.method === "memory.profile.settings.get") reply(res, request, { status: 0, result: { enabled: f.enabled } });
      else if (request.method === "memory.profile.settings.set") {
        f.enabled = request.params.enabled;
        reply(res, request, { status: 0, result: { enabled: f.enabled, applied: true, persisted: true } });
      } else if (request.method === "memory.profile.get") reply(res, request, { status: 0, result: f.profile });
      else if (request.method === "memory.profile.modify") reply(res, request, { status: 0,
        result: f.enabled ? edited : { skipped: true, reason: "memory_disabled", storeCompleted: false } });
      else if (request.method === "memory.profile.reset") reply(res, request, { status: 0, result: resetReceipt(request.params.dry_run) });
      else if (request.method === "memory.profile.reset.status") reply(res, request,
        { status: 0, result: { requestId: request.params.request_id, state: "not_found", response: null } });
      else { res.writeHead(404);res.end(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  f.config = { backend: "mcp-http" as const, endpoint: `http://127.0.0.1:${(server.address() as any).port}/mcp`, tokenFile };
  f.client = new MemoryMcpClient(f.config, { requestMs: 150, probeMs: 500, connectMs: 100 });
  f.service = new MemoryService(f.client, "fixture-account");
  f.count = (method: string) => f.calls.filter((call: any) => call.method === method).length;
  try { await run(f); } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
const context = (action: string, params: any = {}, messageId = action) => ({ action, params, messageId, sessionId: "test-session" });

/** Shared assertions can run under the repository's Vitest or Node's native runner. */
export function registerMemoryMcpTests(test: (name: string, run: () => Promise<void> | void, skip?: boolean) => unknown) {
  test("MCP config is explicit, loopback-only and has no alternate credential source", () => {
    assert.equal(resolveMemoryMcpConfig(undefined, {}), undefined);
    const env = { CELIA_MEMORY_HTTP_URL: "http://127.0.0.1:8675/mcp", CELIA_MEMORY_HTTP_TOKEN_FILE: "/private/token" };
    assert.equal(resolveMemoryMcpConfig({ backend: "mcp-http" }, env)?.endpoint, env.CELIA_MEMORY_HTTP_URL);
    for (const endpoint of ["http://localhost:8675/mcp", "http://192.0.2.1/mcp", "https://127.0.0.1/mcp",
      "http://user@127.0.0.1/mcp", "http://127.0.0.1/mcp?token=x", "http://127.0.0.1/other"]) {
      assert.throws(() => resolveMemoryMcpConfig({ backend: "mcp-http" }, { ...env, CELIA_MEMORY_HTTP_URL: endpoint }));
    }
    assert.throws(() => resolveMemoryMcpConfig({ backend: "mcp-http" }, {}));
    assert.throws(() => resolveMemoryMcpConfig({ backend: "other" }, env));
    assert.throws(() => resolveMemoryMcpConfig({ backend: "mcp-http", token: "x" }, env));
  });

  test("switch actions reach native settings RPC, preserve booleans and never send UI identity", () => fixture(async f => {
    assert.equal((await f.service.handle(context("MemoryStateGet"))).memoryState, true);
    const answer = await f.service.handle(context("MemoryStateSet", { body: { memoryState: false } }));
    assert.equal(answer.ok, true);assert.equal(answer.code, 0);assert.equal(answer.memoryState, false);
    const call = f.calls.find((call: any) => call.method === "memory.profile.settings.set");
    assert.deepEqual(call.params, { enabled: false });
    assert.equal(call.request_id, answer.requestId);
    assert.equal(f.count("initialize"), 1);
    assert(!f.calls.some((call: any) => call.method === "tools/call"));
    const invalid = await f.service.handle(context("MemoryStateSet", { memoryState: false, userId: "other" }));
    assert.equal(invalid.errorCode, "INVALID_REQUEST");assert.equal(f.count("memory.profile.settings.set"), 1);
  }));

  test("unsafe token files never contact the service", () => fixture(async f => {
    await chmod(f.tokenFile, 0o644);
    await assert.rejects(f.client.callProfile("memory.profile.settings.get", {}), { errorCode: "MCP_TOKEN_INVALID" });
    assert.equal(f.calls.length, 0);
    await chmod(f.tokenFile, 0o600);
    const link = join(f.directory, "token-link");await symlink(f.tokenFile, link);
    const client = new MemoryMcpClient({ ...f.config, tokenFile: link });
    await assert.rejects(client.callProfile("memory.profile.settings.get", {}), { errorCode: "MCP_TOKEN_INVALID" });
    assert.equal(f.calls.length, 0);
  }));

  test("failed protocol probe cannot dispatch a mutation", () => fixture(async f => {
    f.route = (request: any, res: ServerResponse) => {
      reply(res, request, { protocolVersion: "wrong" });return true;
    };
    const answer = await f.service.handle(context("MemoryReset"));
    assert.equal(answer.errorCode, "MCP_UNAVAILABLE");assert.equal(f.count("memory.profile.reset"), 0);
  }));

  test("switch success requires applied, persisted and the requested value", () => fixture(async f => {
    f.route = (request: any, res: ServerResponse) => {
      if (request.method !== "memory.profile.settings.set") return false;
      reply(res, request, { status: 0, result: { enabled: false, applied: true, persisted: false } });return true;
    };
    const answer = await f.service.handle(context("MemoryStateSet", { memoryState: false }));
    assert.equal(answer.ok, false);assert.equal(answer.outcome, "unknown");assert.equal(answer.nativeStatus, 0);
  }));

  test("failed switch rollback exposes recoveryRequired instead of confirming the switch", () => fixture(async f => {
    f.route = (request: any, res: ServerResponse) => {
      if (request.method !== "memory.profile.settings.set") return false;
      reply(res, request, { status: -4, result: { enabled: false, applied: false, persisted: true,
        rolledBack: false, runtimeRestored: false, recoveryRequired: true } });return true;
    };
    const answer = await f.service.handle(context("MemoryStateSet", { memoryState: false }));
    assert.equal(answer.ok, false);assert.equal(answer.outcome, "recovery_required");assert.equal(answer.nativeStatus, -4);
    assert.equal(answer.result.recoveryRequired, true);
  }));

  test("profile sections share one snapshot and preserve exact private text", () => fixture(async f => {
    const user = await f.service.handle(context("UserMdQuery"));
    assert.equal(user.fileDetail, profile.payload.userMd);
    const memory = await f.service.handle(context("MemoryMdQuery", { snapshotId: user.snapshotId }));
    assert.equal(memory.fileDetail, profile.payload.memoryMd);
    const cloud = await f.service.handle(context("MemoryMdQuery", { snapshotId: user.snapshotId, section: "cloudGlobalSummary" }));
    assert.equal(cloud.fileDetail, profile.payload.cloudGlobalSummary);assert.equal(f.count("memory.profile.get"), 1);
  }));

  test("large Unicode profiles paginate within the doubly encoded WS budget", () => fixture(async f => {
    const original = ('private "\\\n🙂中文 ').repeat(5000);
    f.profile.payload.userMd = original;
    let page = await f.service.handle(context("UserMdQuery"));
    assert.equal(page.hasMore, true);
    const snapshotId = page.snapshotId;
    let full = "";
    for (;;) {
      assert(page.ok);assert(memoryAnswerBytes(page) <= 60_000);
      assert.equal(page.contentBytes, Buffer.byteLength(page.fileDetail));
      assert(!/[\uD800-\uDBFF]$/.test(page.fileDetail));
      full += page.fileDetail;
      if (!page.hasMore) break;
      page = await f.service.handle(context("UserMdQuery", { snapshotId, offset: page.nextOffset }));
    }
    assert.equal(full, original);assert.equal(f.count("memory.profile.get"), 1);
  }));

  test("snapshot expiry and invalid continuation never silently read a new profile", async () => {
    let now = 0;const views = new MemoryViews(() => now);
    const id = views.put("s", { userMd: "private🙂" }, {});
    assert.throws(() => views.page(id, "other", "userMd", 0, {}), { errorCode: "SNAPSHOT_EXPIRED" });
    assert.equal(views.page(id, "s", "userMd", 0, {}).fileDetail, "private🙂");
    const second = views.put("s", { userMd: "private🙂" }, {});now = 30_001;
    assert.throws(() => views.page(second, "s", "userMd", 0, {}), { errorCode: "SNAPSHOT_EXPIRED" });
    await fixture(async f => {
      const result = await f.service.handle(context("UserMdQuery", { offset: 1 }));
      assert.equal(result.errorCode, "INVALID_REQUEST");assert.equal(f.calls.length, 0);
    });
  });

  test("duplicate pending/completed edits dispatch once and conflicts are rejected", () => fixture(async f => {
    const event = context("MemoryProfileModify", { instruction: "用户不爱吃香菜", requestId: "edit-1" });
    const [first, duplicate] = await Promise.all([f.service.handle(event), f.service.handle(event)]);
    assert.deepEqual(first, duplicate);assert.equal(first.ok, true);assert.deepEqual(first.result.atomIds, edited.atomIds);
    assert.equal(f.count("memory.profile.modify"), 1);
    const call = f.calls.find((call: any) => call.method === "memory.profile.modify");
    assert.deepEqual(call.params, { instruction: event.params.instruction, session_id: event.sessionId });
    const conflict = await f.service.handle({ ...event, params: { ...event.params, instruction: "different" } });
    assert.equal(conflict.errorCode, "REQUEST_ID_CONFLICT");assert.equal(f.count("memory.profile.modify"), 1);
  }));

  test("partial edit retains written IDs and never reports success or retries", () => fixture(async f => {
    f.route = (request: any, res: ServerResponse) => {
      if (request.method !== "memory.profile.modify") return false;
      reply(res, request, { status: -3, result: { ...edited, triggerCompleted: false, failureStage: "trigger" } });return true;
    };
    const event = context("MemoryProfileModify", { instruction: "更新画像" });
    const result = await f.service.handle(event);
    assert.equal(result.ok, false);assert.equal(result.outcome, "partial");assert.equal(result.nativeStatus, -3);
    assert.deepEqual(result.result.atomIds, edited.atomIds);
    assert.deepEqual(await f.service.handle(event), result);assert.equal(f.count("memory.profile.modify"), 1);
  }));

  test("disabled edit is explicitly skipped and a mutation invalidates old profile snapshots", () => fixture(async f => {
    const page = await f.service.handle(context("UserMdQuery"));
    await f.service.handle(context("MemoryStateSet", { memoryState: false }));
    const edit = await f.service.handle(context("MemoryProfileModify", { instruction: "更新画像" }));
    assert.equal(edit.ok, false);assert.equal(edit.outcome, "skipped");
    const stale = await f.service.handle(context("UserMdQuery", { snapshotId: page.snapshotId }));
    assert.equal(stale.errorCode, "SNAPSHOT_EXPIRED");
  }));

  test("a profile read spanning a mutation cannot publish a stale snapshot", () => fixture(async f => {
    let heldRequest: any, heldResponse: ServerResponse;
    f.route = (request: any, res: ServerResponse) => {
      if (request.method !== "memory.profile.get") return false;
      heldRequest = request;heldResponse = res;return true;
    };
    const pending = f.service.handle(context("UserMdQuery"));
    await until(() => !!heldRequest);
    assert.equal((await f.service.handle(context("MemoryProfileModify", { instruction: "更新画像" }))).ok, true);
    reply(heldResponse!, heldRequest, { status: 0, result: profile });
    assert.equal((await pending).errorCode, "SNAPSHOT_EXPIRED");
  }));

  test("reset status remains independent before and after a reset transport timeout", () => fixture(async f => {
    let resetRequest: any, resetResponse: ServerResponse, completed = false;
    f.route = (request: any, res: ServerResponse) => {
      if (request.method === "memory.profile.reset") { resetRequest = request;resetResponse = res;return true; }
      if (resetRequest && request.method === "memory.profile.settings.get" && !completed) {
        reply(res, request, { status: -5, result: null });return true;
      }
      if (request.method === "memory.profile.reset.status") {
        reply(res, request, { status: 0, result: { requestId: "reset-1", state: completed ? "succeeded" : "running",
          response: completed ? { status: 0, result: resetReceipt() } : null } });return true;
      }
      return false;
    };
    const event = context("MemoryReset", { requestId: "reset-1" });
    const pending = f.service.handle(event);
    await until(() => !!resetRequest);
    assert.equal((await f.service.handle(context("MemoryResetStatus", { requestId: "reset-1" }))).outcome, "running");
    const timeout = await pending;
    assert.equal(timeout.outcome, "unknown");assert.equal(timeout.requestId, "reset-1");
    assert.equal((await f.service.handle(context("MemoryResetStatus", { requestId: "reset-1" }))).outcome, "running");
    completed = true;reply(resetResponse!, resetRequest, { status: 0, result: resetReceipt() });
    const status = await f.service.handle(context("MemoryResetStatus", { requestId: "reset-1" }));
    assert.equal(status.state, "succeeded");assert.equal(status.ok, true);
    assert.deepEqual(await f.service.handle(event), timeout);assert.equal(f.count("memory.profile.reset"), 1);
  }));

  test("reset preview is distinct from execution and fusion completion is not fabricated", () => fixture(async f => {
    const preview = await f.service.handle(context("MemoryReset", { requestId: "dry", dryRun: true }));
    assert.equal(preview.outcome, "preview");assert.equal(preview.result.coreClearCompleted, false);
    const conflict = await f.service.handle(context("MemoryReset", { requestId: "dry", dryRun: false }));
    assert.equal(conflict.errorCode, "REQUEST_ID_CONFLICT");
    f.route = (request: any, res: ServerResponse) => {
      if (request.method !== "memory.profile.reset") return false;
      reply(res, request, { status: 0, result: resetReceipt(false, true) });return true;
    };
    const reset = await f.service.handle(context("MemoryReset", { requestId: "real" }));
    assert.equal(reset.ok, false);assert.equal(reset.outcome, "sync_required");assert.equal(reset.result.coreClearCompleted, true);
    const absent = await f.service.handle(context("MemoryResetStatus", { requestId: "absent" }));
    assert.equal(absent.ok, false);assert.equal(absent.state, "not_found");
  }));

  test("post-dispatch auth, disconnect, redirect and mismatched replies are not retried", async () => {
    for (const mode of ["auth", "disconnect", "redirect", "wrong-id", "oversized"]) await fixture(async f => {
      await f.service.handle(context("MemoryStateGet"));
      f.route = (request: any, res: ServerResponse) => {
        if (request.method !== "memory.profile.settings.set") return false;
        if (mode === "auth") { res.writeHead(401);res.end(); }
        else if (mode === "disconnect") res.destroy();
        else if (mode === "redirect") { res.writeHead(302, { Location: f.config.endpoint });res.end(); }
        else if (mode === "oversized") reply(res, request, { status: 0, result: { body: "x".repeat(513 * 1024) } });
        else reply(res, { id: "wrong" }, { status: 0, result: { enabled: false, applied: true, persisted: true } });
        return true;
      };
      const answer = await f.service.handle(context("MemoryStateSet", { memoryState: false }));
      assert.equal(answer.ok, false);assert.equal(answer.outcome, mode === "auth" ? "rejected" : "unknown");
      assert.equal(f.count("memory.profile.settings.set"), 1);
    });
  });

  test("private display is preserved only on approved fields and memory logs contain no body", () => {
    const original = { header: { namespace: "AgentEvent", name: "MemoryQuery" }, payload: { action: "UserMdQuery",
      ans: { ok: true, fileDetail: "private profile", message: "private error" } } };
    const redacted = structuredClone(original);redacted.payload.ans.fileDetail = "redacted";redacted.payload.ans.message = "redacted";
    const wire = preserveMemoryDisplay(original, redacted);
    assert.equal(wire.payload.ans.fileDetail, "private profile");assert.equal(wire.payload.ans.message, "redacted");
    const summary = memoryAnswerSummary("UserMdQuery", original.payload.ans);
    assert(!summary.includes("private"));assert(summary.includes("contentBytes="));
    const frame = { params: { message: { parts: [{ kind: "data", data: { events: [original] } }] } } };
    assert(hasMemoryQueryFrame(frame));
    assert(hasMemoryQueryFrame({ msgDetail: JSON.stringify(frame) }));
    assert(!hasMemoryQueryFrame({ params: { message: { parts: [{ kind: "text", text: "ordinary" }] } } }));
  });

  test("actual C MCP manages switch, profile, edit, reset and status through the XY adapter", async () => {
    const binary = process.env.XY_MEMORY_CONTRACT_SERVER!;
    const directory = await mkdtemp(join(tmpdir(), "xy-c-mcp-"));
    const portServer = createServer();
    await new Promise<void>(resolve => portServer.listen(0, "127.0.0.1", resolve));
    const port = (portServer.address() as any).port;
    await new Promise<void>(resolve => portServer.close(() => resolve()));
    const tokenFile = join(directory, "token"), configFile = join(directory, "config.json"), audit = join(directory, "audit");
    await writeFile(tokenFile, TOKEN, { mode: 0o600 });
    await writeFile(configFile, JSON.stringify({ storage: { memoryStore: { type: "sqlite", path: join(directory, "memory.db") } },
      pipeline: {}, runtime: { defaultUserId: "test-user" }, mcp: { http: { enabled: true, port, host: "127.0.0.1" } } }));
    const env: NodeJS.ProcessEnv = { ...process.env, GSPD_MCP_AUTH_TOKEN: TOKEN, GSPD_MCP_CALLER_ID: "test-user", MCP_TEST_AUDIT: audit };
    delete env.GSPD_MCP_PORT;delete env.MCP_TEST_FAULT;
    const child = spawn(binary, ["--config", configFile], { env, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostics = "";child.stderr.on("data", data => { diagnostics = (diagnostics + data).slice(-4000); });
    const service = new MemoryService(new MemoryMcpClient({ backend: "mcp-http", endpoint: `http://127.0.0.1:${port}/mcp`, tokenFile }), "test-user");
    try {
      let ready = false;
      for (let n = 0; n < 80; n++) {
        if ((await service.handle(context("MemoryStateGet"))).ok) { ready = true;break; }
        assert.equal(child.exitCode, null, diagnostics);await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert(ready, diagnostics);
      assert.equal((await service.handle(context("MemoryStateSet", { memoryState: false }, "off"))).ok, true);
      assert.equal((await service.handle(context("UserMdQuery"))).outcome, "skipped");
      assert.equal((await service.handle(context("MemoryStateSet", { memoryState: true }, "on"))).ok, true);
      const edit = await service.handle(context("MemoryProfileModify", { instruction: "用户不爱吃香菜" }));
      assert.equal(edit.ok, true, JSON.stringify(edit));assert.deepEqual(edit.result.atomIds, edited.atomIds);
      const view = await service.handle(context("UserMdQuery"));assert.equal(typeof view.fileDetail, "string");
      const resetEvent = context("MemoryReset", { requestId: "actual-clear" });
      const cleared = await service.handle(resetEvent);
      assert.equal(cleared.result.coreClearCompleted, true);assert.equal(cleared.outcome, "sync_required");
      assert.deepEqual(await service.handle(resetEvent), cleared);
      const status = await service.handle(context("MemoryResetStatus", { requestId: "actual-clear" }));
      assert.equal(status.state, "succeeded");assert.equal(status.result.coreClearCompleted, true);
      assert.equal((await service.handle(context("UserMdQuery"))).fileDetail, "");
    } finally {
      try {
        if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM");await once(child, "exit"); }
        assert.equal(child.exitCode, 0, diagnostics);
        const events = (await readFile(audit, "utf8")).trim().split("\n");
        assert.equal(events.filter(event => event === "clear").length, 1);
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
  }, !process.env.XY_MEMORY_CONTRACT_SERVER);
}

export { fixture as withMemoryMcpFixture };

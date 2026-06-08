// Cron query event handler.
// Listens for cron-query-event from the WebSocket manager,
// calls Gateway cron RPC via callGatewayTool, and sends the
// result back to the client via sendCommand as a System.CronQuery
// command with the result in payload.ans.
import { callGatewayTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import * as os from "os";
import { sendCommand } from "./formatter.js";
import { resolveXYConfig } from "./config.js";
import { logger } from "./utils/logger.js";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const GATEWAY_TIMEOUT_MS = 60_000;
/**
 * Handle a cron-query-event.
 *
 * Calls the Gateway cron RPC and sends the result back through sendCommand
 * as a System.CronQuery command with the full result object in payload.ans.
 */
export async function handleCronQueryEvent(context, cfg) {
    const { action, jobId, params, sessionId, taskId, messageId } = context;
    const log = logger.withContext(sessionId ?? "", taskId ?? "");
    log.log(`[CRON-QUERY] Received event: action=${action}, jobId=${jobId ?? "(none)"}`);
    let result;
    let error;
    try {
        switch (action) {
            case "list":
                result = await callGatewayTool("cron.list", { timeoutMs: GATEWAY_TIMEOUT_MS }, params ?? {});
                break;
            case "status":
                result = await callGatewayTool("cron.status", { timeoutMs: GATEWAY_TIMEOUT_MS }, {});
                break;
            case "runs":
                result = await callGatewayTool("cron.runs", { timeoutMs: GATEWAY_TIMEOUT_MS }, {
                    jobId,
                    ...params,
                });
                break;
            case "add":
                result = await callGatewayTool("cron.add", { timeoutMs: GATEWAY_TIMEOUT_MS }, params ?? {});
                break;
            case "update":
                result = await callGatewayTool("cron.update", { timeoutMs: GATEWAY_TIMEOUT_MS }, {
                    jobId,
                    ...params,
                });
                break;
            case "remove":
                result = await callGatewayTool("cron.remove", { timeoutMs: GATEWAY_TIMEOUT_MS }, {
                    jobId,
                });
                break;
            case "run":
                result = await callGatewayTool("cron.run", { timeoutMs: GATEWAY_TIMEOUT_MS }, {
                    jobId,
                    mode: "force",
                    ...params,
                });
                break;
            case "queryTimeList":
                result = await queryTimeListLocal();
                break;
            default:
                error = `Unknown action: ${context.action}`;
                log.error(`[CRON-QUERY] ${error}`);
                result = { error };
        }
    }
    catch (err) {
        error = err instanceof Error ? err.message : String(err);
        log.error(`[CRON-QUERY] RPC call failed for action=${action}:`, err);
        result = { error };
    }
    // Log the result
    log.log(`[CRON-QUERY] RPC result for action=${action}: ${JSON.stringify(result, null, 2)}`);
    // Send result back via sendCommand as System.CronQuery with payload.ans
    if (cfg && sessionId && taskId && messageId) {
        try {
            const config = resolveXYConfig(cfg);
            const command = {
                header: {
                    namespace: "AgentEvent",
                    name: "CronQuery",
                },
                payload: {
                    action,
                    ans: result,
                },
            };
            await sendCommand({
                config,
                sessionId,
                taskId,
                messageId,
                command,
                final: sessionId.toLowerCase().endsWith("cronquery"),
            });
            log.log(`[CRON-QUERY] Sent response via sendCommand, action=${action}`);
        }
        catch (sendErr) {
            log.error(`[CRON-QUERY] Failed to send response via sendCommand:`, sendErr);
        }
    }
    else {
        log.warn(`[CRON-QUERY] Missing cfg/sessionId/taskId/messageId, skipping sendCommand`);
    }
}

/**
 * Read local cron folder directly (bypassing openclaw RPC) and return
 * run records from the last 7 days, grouped by date and sorted by time.
 *
 * Data sources:
 *   - state/cron/jobs.json   → job id → name mapping
 *   - state/cron/runs/*.jsonl → run records (one JSON per line)
 *
 * Return format:
 *   [ { "YYYY-MM-DD": [ { run record with .name }, ... ] }, ... ]
 */
async function queryTimeListLocal() {
    const cronDir = join(os.homedir(), ".openclaw", "cron");
    const jobsPath = join(cronDir, "jobs.json");
    const runsDir = join(cronDir, "runs");

    // 1. Build jobId → name map from jobs.json
    const jobNameMap = {};
    try {
        const jobsRaw = readFileSync(jobsPath, "utf-8");
        const jobsData = JSON.parse(jobsRaw);
        for (const job of jobsData.jobs || []) {
            jobNameMap[job.id] = job.name || job.id;
        }
    }
    catch (err) {
        logger.error(`[CRON-QUERY] Failed to read jobs.json: ${err.message}`);
    }

    // 2. Read all run files, collect runs within last 7 days
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const allRuns = [];

    let files = [];
    try {
        files = readdirSync(runsDir);
    }
    catch {
        files = [];
    }

    for (const file of files) {
        if (!file.endsWith(".jsonl"))
            continue;
        try {
            const content = readFileSync(join(runsDir, file), "utf-8");
            const lines = content.trim().split("\n");
            for (const line of lines) {
                if (!line.trim())
                    continue;
                try {
                    const run = JSON.parse(line);
                    if (run.ts && run.ts >= sevenDaysAgo) {
                        run.name = jobNameMap[run.jobId] || run.jobId || "";
                        allRuns.push(run);
                    }
                }
                catch {
                    // skip malformed line
                }
            }
        }
        catch (err) {
            logger.error(`[CRON-QUERY] Failed to read run file ${file}: ${err.message}`);
        }
    }

    // 3. Sort by ts ascending
    allRuns.sort((a, b) => a.ts - b.ts);

    // 4. Group by date (YYYY-MM-DD in local time)
    const grouped = new Map();
    for (const run of allRuns) {
        const d = new Date(run.ts);
        const label = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        if (!grouped.has(label)) {
            grouped.set(label, []);
        }
        grouped.get(label).push(run);
    }

    // 5. Convert to ordered array of single-key objects
    const result = [];
    for (const [date, runs] of grouped) {
        result.push({ [date]: runs });
    }

    return result;
}

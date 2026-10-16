/**
 * CompactionProvider for xiaoyi-channel.
 *
 * During compaction, the safeguard's built-in summarization path
 * (summarizeInStages -> generateSummary -> completeSimple) bypasses the
 * plugin's wrapStreamFn, so x-hag-trace-id is never injected. Registering
 * a CompactionProvider intercepts the safeguard before it reaches the LLM
 * path and makes the summarization API call ourselves with proper headers.
 */
import { createHash } from "crypto";
import { logger } from "./utils/logger.js";

// ── Header constants (mirrors provider.ts) ────────────────────────
const HEADER_TRACE_ID = "x-hag-trace-id";
const HEADER_SESSION_ID = "x-session-id";
const HEADER_INTERACTION_ID = "x-interaction-id";

// ── Summarization prompt ──────────────────────────────────────────
const SUMMARIZATION_SYSTEM_PROMPT =
  "You are a structured conversation summarization assistant. " +
  "Produce a concise summary that preserves key facts, decisions, " +
  "in-progress tasks, tool results, and the latest user intent.";

// ── Config storage ────────────────────────────────────────────────
interface CompactionConfig {
  uid: string;
  baseUrl: string;
  modelName: string;
  apiKey?: string;
  /** Provider-level auth headers (x-uid/x-api-key/...), captured from
   *  models.providers.xiaoyiprovider.headers. Used to authorize the
   *  compaction summarization request when no session snapshot exists. */
  headers?: Record<string, string>;
}

/**
 * Snapshot of the resolved session context, captured from the last normal
 * LLM request before compaction is triggered. When available, the
 * CompactionProvider reuses the same A2A traceId/sessionId so the
 * compaction summarization request is linked to the same user session
 * in backend tracing.
 */
interface CompactionSessionSnapshot {
  traceId: string;
  sessionId: string;
  interactionId: string;
  deviceType?: string;
  appVer?: string;
  sdkApiVersion?: string;
  /** Auth headers from options.headers in the last normal request. */
  requestHeaders?: Record<string, string>;
  /** API key from the last normal request (for Bearer token auth). */
  apiKey?: string;
  /** Model-level headers from resolveDynamicModel (streamSimple adds these). */
  modelHeaders?: Record<string, string>;
}

let storedConfig: CompactionConfig | null = null;
let storedSessionSnapshot: CompactionSessionSnapshot | null = null;

/** Store config captured from prepareExtraParams so summarize() can read it. */
export function setCompactionConfig(config: CompactionConfig | null): void {
  storedConfig = config;
  if (config) {
    logger.log(
      `[compaction-provider] config stored uid=${config.uid.slice(0, 8)}... ` +
        `baseUrl=${config.baseUrl} model=${config.modelName}`,
    );
  } else {
    logger.warn("[compaction-provider] config cleared (uid or baseUrl missing)");
  }
}

/**
 * Store a snapshot of the resolved session headers captured from the
 * most recent wrapStreamFn call. This lets the CompactionProvider reuse
 * the A2A traceId/sessionId during compaction summarization.
 */
export function setCompactionSessionSnapshot(snapshot: CompactionSessionSnapshot | null): void {
  storedSessionSnapshot = snapshot;
}

// ── Helpers ───────────────────────────────────────────────────────
function encodeUid(uid: string): string {
  return createHash("sha256").update(uid).digest("hex").slice(0, 32);
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
          return String((block as Record<string, unknown>).text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function formatMessagesForSummarization(messages: unknown[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m.role === "custom") continue; // skip internal runtime messages
    const role = String(m.role ?? "unknown");
    const text = extractMessageText(m.content).trim();
    if (!text) continue;

    let label: string;
    if (role === "assistant") {
      label = "Assistant";
    } else if (role === "user") {
      label = "User";
    } else if (role === "toolResult") {
      const toolName = typeof m.toolName === "string" && m.toolName ? m.toolName : "tool";
      label = `Tool result (${toolName})`;
    } else {
      label = role;
    }
    lines.push(`[${label}]: ${text}`);
  }
  return lines.join("\n\n");
}

/**
 * Extract streamed text from a single chat.completion choice. Compatible with:
 *  - OpenAI SSE streaming: choices[0].delta.content
 *  - OpenAI final (non-streaming): choices[0].message.content
 *  - Xiaoyi compaction API: choices[0].message.token_text (token-level deltas)
 * Almost all compaction backends emit text in one of these three fields.
 */
function extractChoiceContent(choice: Record<string, unknown>): string {
  const delta = isRecord(choice.delta) ? (choice.delta as Record<string, unknown>) : undefined;
  const message = isRecord(choice.message) ? (choice.message as Record<string, unknown>) : undefined;
  const content = delta?.content ?? message?.content ?? message?.token_text;
  return typeof content === "string" ? content : "";
}

/** Type guard: plain object (excludes null and arrays). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ── CompactionProvider ────────────────────────────────────────────
export const xiaoyiCompactionProvider = {
  id: "xiaoyiprovider",
  label: "Xiaoyi Compaction Provider",

  async summarize(params: {
    messages: unknown[];
    signal?: AbortSignal;
    customInstructions?: string;
    summarizationInstructions?: { identifierPolicy?: string; identifierInstructions?: string };
    previousSummary?: string;
  }): Promise<string> {
    const cfg = storedConfig;
    if (!cfg) {
      // No stored config: let the safeguard fall through to the LLM path.
      // Throwing here is intentional — tryProviderSummarize catches and
      // falls through.
      throw new Error("Compaction config not available (uid or baseUrl missing)");
    }

    // Use the A2A session snapshot when available (captured from the last
    // normal wrapStreamFn call before compaction was triggered). Otherwise
    // fall back to the uid_timestamp pattern.
    const session = storedSessionSnapshot;
    const traceId = session?.traceId ?? `${encodeUid(cfg.uid)}_${Date.now()}`;
    const sessionId = session?.sessionId ?? traceId;
    const interactionId = session?.interactionId ?? traceId;
    logger.log(
      `[compaction-provider] summarize traceId=${traceId} source=${session ? "a2a-snapshot" : "uid-fallback"} msgCount=${params.messages.length}`,
    );

    // ── Build prompt ──────────────────────────────────────────────
    const conversationText = formatMessagesForSummarization(params.messages);

    let promptText = `<conversation>\n${conversationText}\n</conversation>`;
    if (params.previousSummary) {
      promptText += `\n\n<previous-summary>\n${params.previousSummary}\n</previous-summary>`;
    }

    let instructions =
      "Provide a concise but comprehensive summary of the conversation above. " +
      "Include: key decisions, in-progress tasks, tool results, file operations, " +
      "and the latest user request. Preserve exact file paths, URLs, identifiers, " +
      "and error messages.";
    if (params.customInstructions) {
      instructions += `\n\nAdditional focus: ${params.customInstructions}`;
    }
    promptText += `\n\n${instructions}`;

    // ── Build request ─────────────────────────────────────────────
    // Reconstruct the exact same headers that the normal request uses.
    // streamSimple adds model.headers to the HTTP request directly, so
    // we capture them separately from options.headers.
    const reqHdrs = session?.requestHeaders;
    const modelHdrs = session?.modelHeaders;
    const reqKeys = reqHdrs ? Object.keys(reqHdrs) : [];
    const modelKeys = modelHdrs ? Object.keys(modelHdrs) : [];
    logger.log(
      `[compaction-provider] snapshot auth: hasApiKey=${!!session?.apiKey} ` +
        `requestHeaders=[${reqKeys.join(",")}] modelHeaders=[${modelKeys.join(",")}]`,
    );

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // uid-fallback: no session snapshot (compaction may fire on the very
      // first turn before any normal LLM call captured auth headers). Attach
      // the provider-level headers captured from models.providers.xiaoyiprovider
      // so the compaction summarization request is still authorized.
      ...(session ? {} : cfg.headers),
      ...modelHdrs,
      ...reqHdrs,
      ...(session?.apiKey ? { Authorization: `Bearer ${session.apiKey}` }
        : !session && cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      [HEADER_TRACE_ID]: traceId,
      [HEADER_SESSION_ID]: sessionId,
      [HEADER_INTERACTION_ID]: interactionId,
    };

    if (session?.deviceType) {
      headers["x-device-type"] = session.deviceType;
    }
    if (session?.appVer) {
      headers["x-app-ver"] = session.appVer;
    }
    if (session?.sdkApiVersion) {
      headers["x-sdk-api-version"] = session.sdkApiVersion;
    }

    const body = {
      model: cfg.modelName,
      messages: [
        { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
        { role: "user", content: promptText },
      ],
      max_tokens: 4096,
      temperature: 0.3,
    };

    const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    // Log headers for diagnostics (redact sensitive values)
    const safeHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase().includes("auth") || key.toLowerCase().includes("api-key")) {
        safeHeaders[key] = value ? `${value.slice(0, 4)}***` : "(empty)";
      } else {
        safeHeaders[key] = value;
      }
    }
    logger.log(
      `[compaction-provider] POST ${url} headers=${JSON.stringify(safeHeaders)}`,
    );

    // ── Call ──────────────────────────────────────────────────────
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (err) {
      logger.error(`[compaction-provider] fetch failed: ${String(err)}`);
      throw err;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      logger.error(
        `[compaction-provider] API error status=${response.status} body=${errorText.slice(0, 500)}`,
      );
      throw new Error(`Compaction API returned ${response.status}`);
    }

    // 兼容多种响应形态：标准 text/event-stream SSE 帧、纯 JSON，以及
    // content-type 标为 application/json 但 body 实为 `data:` 帧的自定义
    // SSE（xiaoyi compaction API /chat/completions 即如此，curl 实测每帧形如
    // `data: {"choices":[{"message":{"token_text":"..."}}]}`）。
    const contentType = response.headers.get("content-type") || "";
    let summary: string | undefined;

    if (
      response.body &&
      (contentType.includes("text/event-stream") ||
        contentType.includes("text/event") ||
        contentType.includes("application/json"))
    ) {
      // ── SSE / JSON 统一按行解析 ─────────────────────────────
      const streamBody = response.body as unknown as AsyncIterable<Uint8Array>;

      let buffer = "";
      let fullText = "";
      const chunks: string[] = [];
      let sawDataFrame = false;

      // 流式解码器：跨网络 chunk 顺序带状态（{ stream: true }），多字节 UTF-8
      // 字符被切在 chunk 边界时能正确续接，而不是各自独立解码产生替换符 U+FFFD。
      // decoder 必须存活于整个循环（每次迭代复用），循环结束后 flush 残留字节。
      const decoder = new TextDecoder();

      // @types/node@20 的 web ReadableStream 类型未声明 Symbol.asyncIterator，
      // 故先过 unknown 再做显式 AsyncIterable 断言以让 TS 编译通过；运行时语义不变。
      for await (const chunk of streamBody) {
        if (!chunk) continue;
        // chunk 是 Uint8Array，其 toString() 返回逗号分隔的字节数字串而非文本，
        // 必须用 TextDecoder 按 UTF-8 解码，否则永远匹配不到 data: 帧导致压缩必失败。
        const decoded = decoder.decode(chunk, { stream: true });
        buffer += decoded;
        fullText += decoded;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmedLine = line.replace(/\r$/, "");
          if (!trimmedLine || !trimmedLine.startsWith("data:")) continue;
          sawDataFrame = true;

          const dataContent = trimmedLine.slice(5).trim();
          if (!dataContent || dataContent === "[DONE]") continue;

          try {
            const dataJson = JSON.parse(dataContent);
            // Accumulate any of delta.content / message.content / message.token_text
            const content = extractChoiceContent(dataJson?.choices?.[0]);
            if (content) {
              chunks.push(content);
            }
          } catch {
            // Non-JSON data frame (e.g. ping/heartbeat), skip
          }
        }
      }

      // Flush decoder 残留的尾部分字节（若流最后一个 chunk 截断了多字节字符）。
      const flushTail = decoder.decode();
      buffer += flushTail;
      fullText += flushTail;

      // Flush any remaining buffer (可能带尾随换行/空行前缀)
      if (buffer.trimStart().startsWith("data:")) {
        sawDataFrame = true;
        const dataContent = buffer.trimStart().slice(5).trim();
        if (dataContent && dataContent !== "[DONE]") {
          try {
            const dataJson = JSON.parse(dataContent);
            const content = extractChoiceContent(dataJson?.choices?.[0]);
            if (content) chunks.push(content);
          } catch {
            // ignore
          }
        }
      }

      // 非 SSE：body 是单条纯 JSON（无 data: 帧，可能为格式化多行 JSON）时，
      // 用累积的完整原始文本整体解析，避免 split("\n") 拆行后丢行。
      if (!sawDataFrame && fullText.trim()) {
        try {
          const dataJson = JSON.parse(fullText.trim());
          const content = extractChoiceContent(dataJson?.choices?.[0]);
          if (content && !chunks.includes(content)) chunks.push(content);
        } catch {
          // ignore
        }
      }

      summary = chunks.join("");
    } else {
      // ── Non-SSE JSON response (fallback) ────────────────────────
      const data = (await response.json()) as {
        choices?: Array<Record<string, unknown>>;
      };
      summary = data.choices?.[0] ? extractChoiceContent(data.choices[0]) : undefined;
    }

    if (!summary?.trim()) {
      logger.warn("[compaction-provider] empty summary returned");
      throw new Error("Empty summary from compaction API");
    }

    logger.log(`[compaction-provider] done summaryLen=${summary.length}`);
    return summary;
  },
};

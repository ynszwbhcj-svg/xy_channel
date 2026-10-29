import { describe, expect, it } from "vitest";

import { isRetryableProviderError } from "../src/provider.js";

/**
 * Regression tests for isRetryableProviderError.
 *
 * Scope: several "Auto-Model 流式响应被异常终止" incidents surfaced as a
 * raw SSE termination error (`terminated`, HTTP 408). Previously the matcher
 * only recognized 3 hardcoded upstream gateway texts, so `terminated` was
 * judged non-retryable and the failure surfaced straight to the user with no
 * fallback (Auto-Model has none). These tests lock in that undici/Node
 * transport-termination errors are now retryable, matching openclaw's
 * retry-evidence list, while keeping the legacy messages recognized too.
 */

describe("isRetryableProviderError", () => {
  describe("legacy upstream gateway texts (must keep working)", () => {
    it("recognizes OpenAI server error text", () => {
      expect(isRetryableProviderError("The server had an error while processing your request. Sorry about that!")).toBe(true);
      expect(isRetryableProviderError("the server had an error while processing your request")).toBe(true);
    });

    it("recognizes rate-limit text", () => {
      expect(isRetryableProviderError("Rate limit reached for requests")).toBe(true);
    });

    it("recognizes the 小艺 crowding text", () => {
      expect(isRetryableProviderError("现在访问有点拥挤，稍等一下再试会更顺畅哦～")).toBe(true);
    });
  });

  describe("undici / Node transport termination (the new class)", () => {
    it("recognizes the raw SSE `terminated` error (the Auto-Model incident)", () => {
      expect(isRetryableProviderError("terminated")).toBe(true);
    });

    it("recognizes undici UND_ERR_* transport codes", () => {
      expect(isRetryableProviderError("UND_ERR_BODY_TIMEOUT")).toBe(true);
      expect(isRetryableProviderError("UND_ERR_HEADERS_TIMEOUT")).toBe(true);
      expect(isRetryableProviderError("UND_ERR_CONNECT_TIMEOUT")).toBe(true);
      expect(isRetryableProviderError("UND_ERR_SOCKET")).toBe(true);
      expect(isRetryableProviderError("UND_ERR_DNS_RESOLVE_FAILED")).toBe(true);
    });

    it("recognizes node http/net error codes", () => {
      expect(isRetryableProviderError("socket ECONNRESET")).toBe(true);
      expect(isRetryableProviderError("ETIMEDOUT")).toBe(true);
      expect(isRetryableProviderError("ECONNREFUSED")).toBe(true);
      expect(isRetryableProviderError("ESOCKETTIMEDOUT")).toBe(true);
      expect(isRetryableProviderError("EPIPE")).toBe(true);
      expect(isRetryableProviderError("EAI_AGAIN")).toBe(true);
    });

    it("recognizes human-readable transport snippets", () => {
      expect(isRetryableProviderError("socket hang up")).toBe(true);
      expect(isRetryableProviderError("TypeError: fetch failed")).toBe(true);
      expect(isRetryableProviderError("connect timeout")).toBe(true);
      expect(isRetryableProviderError("upstream connect error")).toBe(true);
      expect(isRetryableProviderError("request body timeout")).toBe(true);
      expect(isRetryableProviderError("network is unreachable")).toBe(true);
    });

    it("is case-insensitive", () => {
      expect(isRetryableProviderError("Terminated")).toBe(true);
      expect(isRetryableProviderError("und_err_body_timeout")).toBe(true);
      expect(isRetryableProviderError("Socket Hang Up")).toBe(true);
    });
  });

  describe("non-retryable inputs (must stay false)", () => {
    it("returns false for undefined / empty message", () => {
      expect(isRetryableProviderError(undefined)).toBe(false);
      expect(isRetryableProviderError("")).toBe(false);
    });

    it("does not retry semantic model errors (content filter / auth / bad request)", () => {
      expect(isRetryableProviderError('{"error":{"type":"content_filter","message":"Response filtered"}}')).toBe(false);
      expect(isRetryableProviderError("invalid api key")).toBe(false);
      expect(isRetryableProviderError("Bad Request: parameter max_tokens is too large")).toBe(false);
      expect(isRetryableProviderError("模型上下文长度不足")).toBe(false);
    });

    it("does not retry the empty-object error body seen in some failures", () => {
      // The `{}` raw error is an unclassified/semantic response, not a
      // transport cut — intentional: no retry loop to avoid hammering on a
      // stable provider-side rejection.
      expect(isRetryableProviderError("{}")).toBe(false);
    });
  });
});

// ACP Session Binding Adapter for xiaoyi-channel.
// Follows the feishu thread-bindings.ts pattern.
//
// Maps A2A sessionId (stable conversation identifier) to ACP/subagent
// session keys so that openclaw can bind spawned sessions to the
// current xiaoyi conversation.
//
// Key design: xiaoyi-channel only supports `placement: "current"` —
// it cannot create child threads (unlike Discord). All spawned sessions
// are bound to the current A2A conversation identified by sessionId.
// NOTE: Using `any` for cfg type to avoid version mismatch between
// local and global openclaw installs (auth.profiles.aws-sdk union).
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingConversationIdFromBindingId,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { logger } from "./utils/logger.js";

// ─── Types ────────────────────────────────────────────────────

type XyBindingTargetKind = "subagent" | "acp";

type XyAcpBindingRecord = {
  accountId: string;
  conversationId: string;       // A2A sessionId
  parentConversationId?: string;
  deliveryTo?: string;
  targetKind: XyBindingTargetKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
};

type XyAcpBindingManager = {
  accountId: string;
  getByConversationId: (conversationId: string) => XyAcpBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => XyAcpBindingRecord[];
  bindConversation: (params: {
    conversationId: string;
    parentConversationId?: string;
    targetKind: BindingTargetKind;
    targetSessionKey: string;
    metadata?: Record<string, unknown>;
  }) => XyAcpBindingRecord | null;
  touchConversation: (conversationId: string, at?: number) => XyAcpBindingRecord | null;
  unbindConversation: (conversationId: string) => XyAcpBindingRecord | null;
  unbindBySessionKey: (targetSessionKey: string) => XyAcpBindingRecord[];
  stop: () => void;
};

type XyAcpBindingsState = {
  managersByAccountId: Map<string, XyAcpBindingManager>;
  bindingsByAccountConversation: Map<string, XyAcpBindingRecord>;
};

// ─── Global state (survives module dedup) ─────────────────────

const XY_ACP_BINDINGS_KEY = Symbol.for("openclaw.xyAcpBindingsState");
let state: XyAcpBindingsState | undefined;

function getState(): XyAcpBindingsState {
  if (!state) {
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    state = (globalStore[XY_ACP_BINDINGS_KEY] as XyAcpBindingsState | undefined) ?? {
      managersByAccountId: new Map(),
      bindingsByAccountConversation: new Map(),
    };
    globalStore[XY_ACP_BINDINGS_KEY] = state;
  }
  return state;
}

function resolveBindingKey(params: { accountId: string; conversationId: string }): string {
  return `${params.accountId}:${params.conversationId}`;
}

// ─── Kind conversion ──────────────────────────────────────────

function toSessionBindingTargetKind(raw: XyBindingTargetKind): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toXyTargetKind(raw: BindingTargetKind): XyBindingTargetKind {
  return raw === "subagent" ? "subagent" : "acp";
}

// ─── Record conversion ────────────────────────────────────────

function toSessionBindingRecord(
  record: XyAcpBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  const idleExpiresAt =
    defaults.idleTimeoutMs > 0 ? record.lastActivityAt + defaults.idleTimeoutMs : undefined;
  const maxAgeExpiresAt = defaults.maxAgeMs > 0 ? record.boundAt + defaults.maxAgeMs : undefined;
  const expiresAt =
    idleExpiresAt != null && maxAgeExpiresAt != null
      ? Math.min(idleExpiresAt, maxAgeExpiresAt)
      : (idleExpiresAt ?? maxAgeExpiresAt);
  return {
    bindingId: resolveBindingKey({
      accountId: record.accountId,
      conversationId: record.conversationId,
    }),
    targetSessionKey: record.targetSessionKey,
    targetKind: toSessionBindingTargetKind(record.targetKind),
    conversation: {
      channel: "xiaoyi-channel",
      accountId: record.accountId,
      conversationId: record.conversationId,
      parentConversationId: record.parentConversationId,
    },
    status: "active",
    boundAt: record.boundAt,
    expiresAt,
    metadata: {
      agentId: record.agentId,
      label: record.label,
      boundBy: record.boundBy,
      deliveryTo: record.deliveryTo,
      lastActivityAt: record.lastActivityAt,
      idleTimeoutMs: defaults.idleTimeoutMs,
      maxAgeMs: defaults.maxAgeMs,
    },
  };
}

// ─── Manager factory ──────────────────────────────────────────

export function createXyAcpBindingManager(params: {
  accountId?: string;
  cfg: any;
}): XyAcpBindingManager {
  const accountId = normalizeAccountId(params.accountId);
  const existing = getState().managersByAccountId.get(accountId);
  if (existing) {
    return existing;
  }

  const idleTimeoutMs = resolveThreadBindingIdleTimeoutMsForChannel({
    cfg: params.cfg,
    channel: "xiaoyi-channel",
    accountId,
  });
  const maxAgeMs = resolveThreadBindingMaxAgeMsForChannel({
    cfg: params.cfg,
    channel: "xiaoyi-channel",
    accountId,
  });

  const log = logger.withContext("", "");

  const manager: XyAcpBindingManager = {
    accountId,
    getByConversationId: (conversationId) =>
      getState().bindingsByAccountConversation.get(
        resolveBindingKey({ accountId, conversationId }),
      ),
    listBySessionKey: (targetSessionKey) =>
      [...getState().bindingsByAccountConversation.values()].filter(
        (record) => record.accountId === accountId && record.targetSessionKey === targetSessionKey,
      ),
    bindConversation: ({
      conversationId,
      parentConversationId,
      targetKind,
      targetSessionKey,
      metadata,
    }) => {
      const normalizedConversationId = conversationId.trim();
      const normalizedTargetSessionKey = targetSessionKey.trim();
      if (!normalizedConversationId || !normalizedTargetSessionKey) {
        return null;
      }
      const existingLocal = getState().bindingsByAccountConversation.get(
        resolveBindingKey({ accountId, conversationId: normalizedConversationId }),
      );
      const now = Date.now();
      const record: XyAcpBindingRecord = {
        accountId,
        conversationId: normalizedConversationId,
        parentConversationId:
          normalizeOptionalString(parentConversationId) ?? existingLocal?.parentConversationId,
        deliveryTo:
          typeof metadata?.deliveryTo === "string" && metadata.deliveryTo.trim()
            ? metadata.deliveryTo.trim()
            : existingLocal?.deliveryTo,
        targetKind: toXyTargetKind(targetKind),
        targetSessionKey: normalizedTargetSessionKey,
        agentId:
          typeof metadata?.agentId === "string" && metadata.agentId.trim()
            ? metadata.agentId.trim()
            : (existingLocal?.agentId ?? resolveAgentIdFromSessionKey(normalizedTargetSessionKey)),
        label:
          typeof metadata?.label === "string" && metadata.label.trim()
            ? metadata.label.trim()
            : existingLocal?.label,
        boundBy:
          typeof metadata?.boundBy === "string" && metadata.boundBy.trim()
            ? metadata.boundBy.trim()
            : existingLocal?.boundBy,
        boundAt: now,
        lastActivityAt: now,
      };
      getState().bindingsByAccountConversation.set(
        resolveBindingKey({ accountId, conversationId: normalizedConversationId }),
        record,
      );
      log.log(`[XY-ACP-BIND] Bound ${targetKind} session ${normalizedTargetSessionKey.slice(0, 30)} to conversation ${normalizedConversationId.slice(0, 12)}`);
      return record;
    },
    touchConversation: (conversationId, at = Date.now()) => {
      const key = resolveBindingKey({ accountId, conversationId });
      const existingRecord = getState().bindingsByAccountConversation.get(key);
      if (!existingRecord) {
        return null;
      }
      const updated = { ...existingRecord, lastActivityAt: at };
      getState().bindingsByAccountConversation.set(key, updated);
      return updated;
    },
    unbindConversation: (conversationId) => {
      const key = resolveBindingKey({ accountId, conversationId });
      const existingRecord = getState().bindingsByAccountConversation.get(key);
      if (!existingRecord) {
        return null;
      }
      getState().bindingsByAccountConversation.delete(key);
      return existingRecord;
    },
    unbindBySessionKey: (targetSessionKey) => {
      const removed: XyAcpBindingRecord[] = [];
      for (const record of getState().bindingsByAccountConversation.values()) {
        if (record.accountId !== accountId || record.targetSessionKey !== targetSessionKey) {
          continue;
        }
        getState().bindingsByAccountConversation.delete(
          resolveBindingKey({ accountId, conversationId: record.conversationId }),
        );
        removed.push(record);
      }
      return removed;
    },
    stop: () => {
      for (const key of getState().bindingsByAccountConversation.keys()) {
        if (key.startsWith(`${accountId}:`)) {
          getState().bindingsByAccountConversation.delete(key);
        }
      }
      getState().managersByAccountId.delete(accountId);
      unregisterSessionBindingAdapter({
        channel: "xiaoyi-channel",
        accountId,
        adapter: sessionBindingAdapter,
      });
      log.log(`[XY-ACP-BIND] Stopped binding manager for account ${accountId}`);
    },
  };

  const sessionBindingAdapter: SessionBindingAdapter = {
    channel: "xiaoyi-channel",
    accountId,
    capabilities: {
      placements: ["current"],
    },
    bind: async (input) => {
      if (input.conversation.channel !== "xiaoyi-channel" || input.placement === "child") {
        return null;
      }
      const bound = manager.bindConversation({
        conversationId: input.conversation.conversationId,
        parentConversationId: input.conversation.parentConversationId,
        targetKind: input.targetKind,
        targetSessionKey: input.targetSessionKey,
        metadata: input.metadata,
      });
      return bound ? toSessionBindingRecord(bound, { idleTimeoutMs, maxAgeMs }) : null;
    },
    listBySession: (targetSessionKey) =>
      manager
        .listBySessionKey(targetSessionKey)
        .map((entry) => toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs })),
    resolveByConversation: (ref) => {
      if (ref.channel !== "xiaoyi-channel") {
        return null;
      }
      const found = manager.getByConversationId(ref.conversationId);
      return found ? toSessionBindingRecord(found, { idleTimeoutMs, maxAgeMs }) : null;
    },
    touch: (bindingId, at) => {
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId,
      });
      if (conversationId) {
        manager.touchConversation(conversationId, at);
      }
    },
    unbind: async (input) => {
      if (input.targetSessionKey?.trim()) {
        return manager
          .unbindBySessionKey(input.targetSessionKey.trim())
          .map((entry) => toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs }));
      }
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId: input.bindingId,
      });
      if (!conversationId) {
        return [];
      }
      const removed = manager.unbindConversation(conversationId);
      return removed ? [toSessionBindingRecord(removed, { idleTimeoutMs, maxAgeMs })] : [];
    },
  };

  registerSessionBindingAdapter(sessionBindingAdapter);
  getState().managersByAccountId.set(accountId, manager);
  log.log(`[XY-ACP-BIND] Created binding manager for account ${accountId} (idleTimeout=${idleTimeoutMs}ms, maxAge=${maxAgeMs}ms)`);
  return manager;
}

export function getXyAcpBindingManager(
  accountId?: string,
): XyAcpBindingManager | null {
  return getState().managersByAccountId.get(normalizeAccountId(accountId)) ?? null;
}

import { type BindingTargetKind } from "openclaw/plugin-sdk/conversation-runtime";
type XyBindingTargetKind = "subagent" | "acp";
type XyAcpBindingRecord = {
    accountId: string;
    conversationId: string;
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
export declare function createXyAcpBindingManager(params: {
    accountId?: string;
    cfg: any;
}): XyAcpBindingManager;
export declare function getXyAcpBindingManager(accountId?: string): XyAcpBindingManager | null;
export {};

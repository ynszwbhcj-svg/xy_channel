// Thread binding API for xiaoyi-channel.
// Loaded by openclaw's loadBundledChannelThreadBindingApi() mechanism.
//
// xiaoyi-channel uses "current" placement — ACP/subagent sessions are bound
// to the current A2A conversation (identified by sessionId), not to child
// threads (xiaoyi A2A protocol has no thread concept).
export const defaultTopLevelPlacement = "current" as const;

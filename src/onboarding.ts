// XY Channel Onboarding Adapter
// Implements OpenClaw's ChannelOnboardingAdapter interface for Xiaoyi A2A protocol
import type {
  ChannelOnboardingAdapter,
  ClawdbotConfig,
  WizardPrompter,
} from "openclaw/plugin-sdk";

const channel = "xiaoyi-channel" as const;

/**
 * Check if XY channel is properly configured with required fields
 */
function isXYConfigured(cfg: ClawdbotConfig): boolean {
  try {
    const xyConfig = cfg.channels?.["xiaoyi-channel"];
    if (!xyConfig) {
      return false;
    }

    // Check required fields
    const requiredFields = ["apiKey", "agentId", "uid", "apiId", "pushId"];
    for (const field of requiredFields) {
      if (!xyConfig[field] || (typeof xyConfig[field] === "string" && !xyConfig[field].trim())) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Get current status of XY channel configuration
 */
async function getStatus({ cfg }: { cfg: ClawdbotConfig }): Promise<{
  channel: typeof channel;
  configured: boolean;
  statusLines: string[];
  selectionHint?: string;
  quickstartScore?: number;
}> {
  const configured = isXYConfigured(cfg);
  const xyConfig = cfg.channels?.["xiaoyi-channel"];

  const statusLines: string[] = [];

  if (configured) {
    const wsUrl1 = xyConfig?.wsUrl1 || "ws://localhost:8765/ws/link";
    const wsUrl2 = xyConfig?.wsUrl2 || "ws://localhost:8768/ws/link";
    statusLines.push(`XY: configured (双 WebSocket: ${wsUrl1}, ${wsUrl2})`);
  } else {
    statusLines.push("XY: 需要配置 (需要 apiKey, agentId, uid, apiId, pushId)");
  }

  return {
    channel,
    configured,
    statusLines,
    selectionHint: configured ? "configured" : "需要配置",
    quickstartScore: configured ? 5 : 0,
  };
}

/**
 * Configure XY channel through interactive prompts
 */
async function configure({
  cfg,
  prompter,
}: {
  cfg: ClawdbotConfig;
  prompter: WizardPrompter;
}): Promise<{
  cfg: ClawdbotConfig;
  accountId?: string;
}> {
  // Note current configuration status
  const currentConfig = cfg.channels?.["xiaoyi-channel"];
  const isUpdate = Boolean(currentConfig);

  await prompter.note(
    [
      "XY Channel - 小艺 A2A 协议配置",
      "",
      "XY 是小艺智能助手的 A2A (Agent-to-Agent) 协议集成，",
      "需要配置双 WebSocket 连接和相关认证信息。",
      "",
      isUpdate ? "当前配置将被更新。" : "首次配置 XY channel。",
    ].join("\n"),
    "XY Channel 配置"
  );

  // Prompt for WebSocket URLs
  const wsUrl1 = await prompter.text({
    message: "WebSocket URL 1 (主连接)",
    initialValue: currentConfig?.wsUrl1 || "ws://localhost:8765/ws/link",
    placeholder: "ws://localhost:8765/ws/link",
  });

  const wsUrl2 = await prompter.text({
    message: "WebSocket URL 2 (辅助连接)",
    initialValue: currentConfig?.wsUrl2 || "ws://localhost:8768/ws/link",
    placeholder: "ws://localhost:8768/ws/link",
  });

  // Prompt for required authentication fields
  const apiKey = await prompter.text({
    message: "API Key (必需)",
    initialValue: currentConfig?.apiKey || "",
    placeholder: "输入小艺 API Key",
    validate: (value: string) => (value.trim() ? undefined : "API Key 不能为空"),
  });

  const uid = await prompter.text({
    message: "UID - 用户ID (必需)",
    initialValue: currentConfig?.uid || "",
    placeholder: "输入用户 ID",
    validate: (value: string) => (value.trim() ? undefined : "UID 不能为空"),
  });

  const agentId = await prompter.text({
    message: "Agent ID - 智能体ID (必需)",
    initialValue: currentConfig?.agentId || "",
    placeholder: "agent5336cca603f941ee9b112f711805e866",
    validate: (value: string) => (value.trim() ? undefined : "Agent ID 不能为空"),
  });

  const apiId = await prompter.text({
    message: "API ID (必需)",
    initialValue: currentConfig?.apiId || "",
    placeholder: "输入 API ID",
    validate: (value: string) => (value.trim() ? undefined : "API ID 不能为空"),
  });

  const pushId = await prompter.text({
    message: "Push ID (必需)",
    initialValue: currentConfig?.pushId || "",
    placeholder: "输入 Push ID",
    validate: (value: string) => (value.trim() ? undefined : "Push ID 不能为空"),
  });

  // Optional fields
  const fileUploadUrl = await prompter.text({
    message: "File Upload URL (文件上传服务)",
    initialValue: currentConfig?.fileUploadUrl || "http://localhost:8767",
    placeholder: "http://localhost:8767",
  });

  const pushUrl = await prompter.text({
    message: "Push URL (推送服务，可选)",
    initialValue: currentConfig?.pushUrl || "",
    placeholder: "留空使用默认值",
  });

  // Update configuration
  const updatedConfig: ClawdbotConfig = {
    ...cfg,
    channels: {
      ...cfg.channels,
      "xiaoyi-channel": {
        enabled: true,
        wsUrl1: wsUrl1.trim(),
        wsUrl2: wsUrl2.trim(),
        apiKey: apiKey.trim(),
        uid: uid.trim(),
        agentId: agentId.trim(),
        apiId: apiId.trim(),
        pushId: pushId.trim(),
        fileUploadUrl: fileUploadUrl.trim(),
        ...(pushUrl?.trim() ? { pushUrl: pushUrl.trim() } : {}),
      },
    },
  };

  // Show confirmation
  await prompter.note(
    [
      "✅ XY Channel 配置完成",
      "",
      `主连接: ${wsUrl1}`,
      `辅助连接: ${wsUrl2}`,
      `Agent ID: ${agentId}`,
      `UID: ${uid}`,
      "",
      "运行以下命令启动 gateway:",
      "  openclaw gateway restart",
      "",
      "查看日志:",
      "  openclaw logs --follow",
    ].join("\n"),
    "配置成功"
  );

  return {
    cfg: updatedConfig,
    accountId: "default",
  };
}

/**
 * XY Channel Onboarding Adapter
 * Implements the ChannelOnboardingAdapter interface for OpenClaw's onboarding system
 */
export const xyOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,

  getStatus,
  configure,

  // Optional: disable the channel
  disable: (cfg: ClawdbotConfig): ClawdbotConfig => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      "xiaoyi-channel": {
        ...(cfg.channels?.["xiaoyi-channel"] || {}),
        enabled: false,
      },
    },
  }),
};

// JSON Schema definition for XY channel configuration

export const xyConfigSchema = {
  type: "object",
  properties: {
    enabled: {
      type: "boolean",
      description: "Enable/disable the XY channel",
      default: false,
    },
    wsUrl1: {
      type: "string",
      description: "Primary WebSocket URL",
      default: "ws://localhost:8765/ws/link",
    },
    wsUrl2: {
      type: "string",
      description: "Secondary WebSocket URL",
      default: "ws://localhost:8768/ws/link",
    },
    apiKey: {
      type: "string",
      description: "API key for authentication",
    },
    uid: {
      type: "string",
      description: "User ID for file upload",
    },
    agentId: {
      type: "string",
      description: "Agent ID for this bot instance",
    },
    apiId: {
      type: "string",
      description: "API ID for push messages",
    },
    pushId: {
      type: "string",
      description: "Push ID for push messages",
    },
    fileUploadUrl: {
      type: "string",
      description: "Base URL for file upload service",
      default: "http://localhost:8767",
    },
    pushUrl: {
      type: "string",
      description: "URL for push message service",
    },
    defaultSessionId: {
      type: "string",
      description: "Default session ID for push notifications (used when no target is specified, e.g., in cron jobs)",
    },
  },
  required: ["apiKey", "agentId", "uid", "apiId", "pushId"],
} as const;

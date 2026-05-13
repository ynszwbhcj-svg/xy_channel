// Device type to tool name mapping.
// Supports two modes:
//   - allowlist: only listed tools are available (used for restrictive devices like car)
//   - denylist: listed tools are blocked, everything else is available (used for permissive devices like pc)
// Tools NOT listed in any device entry → available to all devices (no restriction).

/** Known device type enum. */
export const DEVICE_TYPES = ["car", "2in1", "phone"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

interface DeviceToolPolicy {
  /** If true, `tools` is an allowlist (only these tools are available). */
  allowlist: boolean;
  /** Tool names for this policy. */
  tools: string[];
}

const DEVICE_TOOL_POLICY: Partial<Record<DeviceType, DeviceToolPolicy>> = {
  "2in1": {
    allowlist: false,
    tools: [
      "xiaoyi_gui_agent",
      "call_phone",
      "send_message",
      "search_message",
      "search_contact",
      "get_contact_tool_schema",
      "query_collection",
      "add_collection",
      "delete_collection",
      "get_collection_tool_schema",
    ],
  },
};

export function filterToolsByDevice(tools: any[], deviceType?: string): any[] {
  if (!deviceType) return tools;

  const policy = (DEVICE_TOOL_POLICY as Record<string, DeviceToolPolicy>)[deviceType];
  if (!policy) return tools; // unrecognized device → no filtering

  if (policy.allowlist) {
    return tools.filter((tool) => policy.tools.includes(tool.name));
  } else {
    return tools.filter((tool) => !policy.tools.includes(tool.name));
  }
}

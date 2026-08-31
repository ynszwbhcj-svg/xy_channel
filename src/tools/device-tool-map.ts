// Device type to tool name mapping.
// Supports two modes:
//   - allowlist: only listed tools are available (used for restrictive devices like car)
//   - denylist: listed tools are blocked, everything else is available (used for permissive devices like pc)
// Tools NOT listed in any device entry → available to all devices (no restriction).

/** Known device type enum. */
export const DEVICE_TYPES = ["car", "2in1", "phone", "web", "pad", "winpc"] as const;
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
      "call_phone",
      "send_message",
      "search_message",
      "search_contact",
      "get_contact_tool_schema",
      "send_html_card"
    ],
  },
  "web": {
    allowlist: true,
    tools: [
      "send_file_to_user",
      "view_push_result",
      "image_reading",
      "convert_time_to_utc8_time",
      "save_self_evolution_skill",
      "display-a2ui-card-bypath",
    ],
  },
  // winpc（Windows PC 客户端）：无任何鸿蒙端侧执行能力，屏蔽所有设备操作执行类工具：
  // call_device_tool + get_*_tool_schema 是备忘录/日历/闹钟/联系人/图库/文件/收藏等
  // 全部端工具的调度与 schema 入口，屏蔽后即覆盖整个端工具注册表（deviceToolRegistry）；
  // xiaoyi_gui_agent / get_user_location / 跨设备工具 / check_plugin_privilege 均需端侧
  // 执行 intent；卡片展示类（send_html_card、display-a2ui-card-bypath）winpc 不支持渲染。
  // 云侧接口工具（send_file_to_user、image_reading、invoke 云侧分发等）保留。
  "winpc": {
    allowlist: false,
    tools: [
      // 端工具总调度入口 + 各域 schema 入口（备忘录/日历/联系人/图库/设备文件/闹钟/收藏）
      "call_device_tool",
      "get_note_tool_schema",
      "get_calendar_tool_schema",
      "get_contact_tool_schema",
      "get_photo_tool_schema",
      "get_device_file_tool_schema",
      "get_alarm_tool_schema",
      "get_collection_tool_schema",
      // 端侧执行 intent 的工具
      "xiaoyi_gui_agent",
      "get_user_location",
      "discover_cross_devices",
      "send_cross_device_task",
      "check_plugin_privilege",
      // 卡片展示类（winpc 不支持渲染）
      "send_html_card",
      "display-a2ui-card-bypath",
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

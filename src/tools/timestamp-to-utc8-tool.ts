// Timestamp to UTC+8 Time tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";

/**
 * XY timestamp to UTC+8 time tool - converts timestamp to UTC+8 time format.
 * Supports both second-level and millisecond-level timestamps.
 *
 * This is a utility tool that doesn't require device communication.
 * It converts Unix timestamp to UTC+8 time in YYYYMMDD hhmmss format.
 *
 * Important: The search_calendar_event and search_alarm tools return timestamps.
 * Call this tool first to convert timestamps to readable UTC+8 time format before
 * presenting results to users or performing further operations.
 */
export const timestampToUtc8Tool: any = {
  name: "convert_timestamp_to_utc8_time",
  label: "Convert Timestamp to UTC+8 Time",
  description: `将时间戳转换为标准 UTC+8 时间格式。支持秒级时间戳和毫秒级时间戳。

输入参数：
- timestamp: 时间戳（数字类型），可以是秒级（10位）或毫秒级（13位）

输出格式：
- YYYYMMDD hhmmss（例如：20240315 143000 表示 2024年3月15日 14:30:00 北京时间）

重要说明：
搜索日程工具（search_calendar_event）和搜索闹钟工具（search_alarm）等工具中返回结果如果包含时间戳。
建议优先调用本时间戳转换工具，将时间戳转换为标准北京时间格式，再基于标准时间进行用户回答或下一步操作。

示例：
- 输入：1710498600（秒级）或 1710498600000（毫秒级）
- 输出：20240315 143000`,

  parameters: {
    type: "object",
    properties: {
      timestamp: {
        type: "number",
        description: "时间戳，支持秒级（10位）或毫秒级（13位）时间戳",
      },
    },
    required: ["timestamp"],
  },

  async execute(toolCallId: string, params: any) {
    // Validate timestamp parameter
    if (params.timestamp === undefined || params.timestamp === null) {
      throw new Error("缺少必需参数：timestamp");
    }

    const timestamp = params.timestamp;

    // Validate it's a number
    if (typeof timestamp !== "number") {
      throw new Error("timestamp 必须是数字类型");
    }

    // Check if timestamp is valid
    if (isNaN(timestamp)) {
      throw new Error("timestamp 不是有效数字");
    }

    // Determine if it's seconds or milliseconds
    // Millisecond timestamps are typically 13 digits (year 2024+)
    // Second timestamps are typically 10 digits
    let timestampInMs: number;

    const timestampStr = Math.abs(timestamp).toString();

    if (timestampStr.length === 13) {
      // It's already in milliseconds
      timestampInMs = timestamp;
    } else if (timestampStr.length === 10) {
      // It's in seconds, convert to milliseconds
      timestampInMs = timestamp * 1000;
    } else if (timestamp > 1000000000000) {
      // Likely milliseconds (greater than year 2001 in milliseconds)
      timestampInMs = timestamp;
    } else {
      // Likely seconds, convert to milliseconds
      timestampInMs = timestamp * 1000;
    }

    // Create Date object from timestamp
    const date = new Date(timestampInMs);

    // Check if date is valid
    if (isNaN(date.getTime())) {
      throw new Error("无效的时间戳，无法转换为日期");
    }

    // Convert to Beijing time (UTC+8)
    const beijingTime = new Date(date.getTime() + (8 * 60 * 60 * 1000));

    // Format: YYYYMMDD hhmmss
    const year = beijingTime.getUTCFullYear();
    const month = beijingTime.getUTCMonth() + 1; // Months are 0-indexed
    const day = beijingTime.getUTCDate();
    const hours = beijingTime.getUTCHours();
    const minutes = beijingTime.getUTCMinutes();
    const seconds = beijingTime.getUTCSeconds();

    // Pad with leading zeros
    const formattedDate = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
    const formattedTime = `${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}${String(seconds).padStart(2, '0')}`;

    const result = `${formattedDate} ${formattedTime}`;

    // Return the formatted time
    return {
      content: [
        {
          type: "text",
          text: result,
        },
      ],
    };
  },
};

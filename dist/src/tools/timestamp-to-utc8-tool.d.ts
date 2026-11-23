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
export declare const timestampToUtc8Tool: any;

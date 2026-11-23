/**
 * XY create alarm tool - creates an alarm on user's device.
 * Requires alarmTime parameter. Other parameters are optional with sensible defaults.
 *
 * Time format: YYYYMMDD hhmmss (e.g., 20240315 143000)
 */
export declare const createAlarmTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            alarmTime: {
                type: string;
                description: string;
            };
            alarmTitle: {
                type: string;
                description: string;
            };
            alarmSnoozeDuration: {
                type: string;
                description: string;
            };
            alarmSnoozeTotal: {
                type: string;
                description: string;
            };
            alarmRingDuration: {
                type: string;
                description: string;
            };
            daysOfWakeType: {
                type: string;
                description: string;
            };
            daysOfWeek: {
                description: string;
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

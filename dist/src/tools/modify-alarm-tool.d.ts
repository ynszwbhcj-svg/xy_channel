/**
 * XY modify alarm tool - modifies an existing alarm on user's device.
 * Requires entityId from search_alarm or create_alarm tool.
 *
 * Prerequisites:
 * 1. Call search_alarm or create_alarm tool first to get entityId
 * 2. Use the entityId to identify which alarm to modify
 */
export declare const modifyAlarmTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            entityId: {
                type: string;
                description: string;
            };
            alarmTime: {
                type: string;
                description: string;
            };
            alarmTitle: {
                type: string;
                description: string;
            };
            alarmState: {
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

/**
 * XY delete alarm tool - deletes existing alarms on user's device.
 * Requires entityId(s) from search_alarm or create_alarm tool as prerequisite.
 *
 * Prerequisites:
 * 1. Call search_alarm or create_alarm tool first to get entityId(s) of alarms
 * 2. Use the entityId(s) to delete those alarms
 *
 * Supports deleting single or multiple alarms in one call.
 */
export declare const deleteAlarmTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            items: {
                description: string;
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

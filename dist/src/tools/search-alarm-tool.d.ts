/**
 * XY search alarm tool - searches alarms on user's device.
 * Returns matching alarms based on various filter criteria.
 *
 * At least one search criterion must be provided.
 * Multiple criteria can be combined.
 */
export declare const searchAlarmTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            rangeType: {
                type: string;
                enum: string[];
                description: string;
            };
            alarmState: {
                type: string;
                enum: number[];
                description: string;
            };
            daysOfWakeType: {
                type: string;
                enum: number[];
                description: string;
            };
            startTime: {
                type: string;
                description: string;
            };
            endTime: {
                type: string;
                description: string;
            };
        };
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

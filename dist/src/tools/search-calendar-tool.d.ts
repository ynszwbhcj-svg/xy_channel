/**
 * XY search calendar event tool - searches calendar events on user's device.
 * Returns matching events based on time range and optional title filter.
 *
 * Time range guidelines:
 * - For a specific day: use 00:00:00 to 23:59:59 of that day
 * - For morning: 06:00:00 to 12:00:00
 * - For afternoon: 12:00:00 to 18:00:00
 * - For evening: 18:00:00 to 24:00:00
 * - For a specific time: use ±1 hour range (e.g., for 3PM, use 14:00:00 to 16:00:00)
 */
export declare const searchCalendarTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            startTime: {
                type: string;
                description: string;
            };
            endTime: {
                type: string;
                description: string;
            };
            title: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

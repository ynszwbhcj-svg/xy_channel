/**
 * XY calendar event tool - creates a calendar event on user's device.
 * Requires title, dtStart (start time), and dtEnd (end time) parameters.
 * Time format must be: yyyy-mm-dd hh:mm:ss
 */
export declare const calendarTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            title: {
                type: string;
                description: string;
            };
            dtStart: {
                type: string;
                description: string;
            };
            dtEnd: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

/**
 * XY search message tool - searches SMS messages on user's device.
 * Returns matching messages based on content keyword search.
 */
export declare const searchMessageTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            content: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

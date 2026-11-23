/**
 * XY note tool - creates a note on user's device.
 * Requires title and content parameters.
 */
export declare const noteTool: {
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
            content: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

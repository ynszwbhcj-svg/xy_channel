/**
 * XY search note tool - searches notes on user's device.
 * Returns matching notes based on query string.
 */
export declare const searchNoteTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

/**
 * XY search email tool - searches emails on user's device (花瓣邮箱).
 * Returns matching emails based on query text and search type.
 */
export declare const searchEmailTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            queryText: {
                type: string;
                description: string;
            };
            type: {
                type: string;
                enum: number[];
                description: string;
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

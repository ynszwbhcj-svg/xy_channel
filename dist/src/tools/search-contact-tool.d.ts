/**
 * XY search contact tool - searches contacts on user's device.
 * Returns matching contact information based on name.
 */
export declare const searchContactTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            name: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

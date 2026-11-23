/**
 * XY search file tool - searches files on user's device file system.
 * Returns matching files based on keyword search in file name or content.
 */
export declare const searchFileTool: {
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

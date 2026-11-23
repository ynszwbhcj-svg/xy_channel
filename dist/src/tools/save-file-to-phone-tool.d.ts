/**
 * XY save file to phone tool - saves files to user's device file manager.
 * Supports local file paths (auto-uploaded to get public URL) and public URLs.
 */
export declare const saveFileToPhoneTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            fileName: {
                type: string;
                description: string;
            };
            url: {
                type: string;
                description: string;
            };
            suffix: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

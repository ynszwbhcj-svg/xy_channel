/**
 * XY send file to user tool - sends local files or remote files to user's device.
 * Supports both local file paths and remote URLs.
 */
export declare const sendFileToUserTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            fileLocalUrls: {
                description: string;
            };
            fileRemoteUrls: {
                description: string;
            };
            fileNames: {
                description: string;
            };
        };
    };
    execute(toolCallId: string, params: any): Promise<any>;
};

/**
 * XY send HTML card tool - sends HTML content as an H5 card to user's device.
 * Prefer this tool over send_file_to_user when sending HTML files to users.
 * Only use send_file_to_user for HTML files when the user explicitly requests the raw file.
 */
export declare const sendHtmlCardTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            htmlUrl: {
                type: string;
                description: string;
            };
            htmlLocal: {
                type: string;
                description: string;
            };
        };
        required: any[];
    };
    execute(toolCallId: string, params: any): Promise<any>;
};

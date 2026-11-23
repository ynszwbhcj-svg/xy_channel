/**
 * XY upload file tool - uploads local files to get publicly accessible URLs.
 * Requires file URIs from search_file tool as prerequisite.
 *
 * Prerequisites:
 * 1. Call search_file tool first to get URIs of files
 * 2. Use the URIs to get public URLs
 *
 * Usage Note:
 * - After getting public URLs, if further processing is needed, download the file first
 * - URLs returned are publicly accessible
 */
export declare const uploadFileTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            fileInfos: {
                description: string;
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<{
        content: {
            type: string;
            text: string;
        }[];
    }>;
};

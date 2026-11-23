/**
 * XY upload photo tool - uploads local photos to get publicly accessible URLs.
 * Requires mediaUris from search_photo_gallery tool as prerequisite.
 *
 * Prerequisites:
 * 1. Call search_photo_gallery tool first to get mediaUris of photos
 * 2. Use the mediaUris (maximum 5 at a time) to get public URLs
 */
export declare const uploadPhotoTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            mediaUris: {
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

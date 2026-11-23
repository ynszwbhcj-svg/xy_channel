/**
 * XY save media to gallery tool - saves image or video files to user's device gallery.
 * Supports local file paths (auto-uploaded to get public URL) and public URLs.
 */
export declare const saveMediaToGalleryTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            mediaType: {
                type: string;
                description: string;
            };
            fileName: {
                type: string;
                description: string;
            };
            url: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

/**
 * XY search photo gallery tool - searches photos in user's gallery.
 * Returns local mediaUri strings that can be used with upload_photo tool.
 *
 * IMPORTANT: The returned mediaUris are LOCAL URIs that cannot be downloaded directly.
 * To get publicly accessible URLs, use the upload_photo tool with these URIs.
 */
export declare const searchPhotoGalleryTool: {
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
    execute(toolCallId: string, params: any): Promise<{
        content: {
            type: string;
            text: string;
        }[];
    }>;
};

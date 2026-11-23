/**
 * XY Image Reading tool - performs image understanding using local or remote image URLs.
 * Supports both local file paths and remote URLs, up to 10 images at once.
 */
export declare const imageReadingTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            images: {
                type: string;
                items: {
                    type: string;
                };
                description: string;
            };
            prompt: {
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

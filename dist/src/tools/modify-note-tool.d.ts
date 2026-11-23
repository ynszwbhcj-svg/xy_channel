/**
 * XY modify note tool - appends content to an existing note on user's device.
 * Requires entityId from search_notes tool as prerequisite.
 *
 * Prerequisites:
 * 1. Call search_notes tool first to get the entityId of target note
 * 2. Use the entityId to append content to that note
 */
export declare const modifyNoteTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            entityId: {
                type: string;
                description: string;
            };
            text: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

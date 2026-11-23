/**
 * XY check plugin privilege tool - checks user authorization for device-side tools
 * used in scheduled tasks.
 */
export declare const checkPluginPrivilegeTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            checkIntentName: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

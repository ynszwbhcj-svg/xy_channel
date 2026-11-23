/**
 * XY send message tool - sends SMS message on user's device.
 * Requires phoneNumber (with +86 prefix) and content parameters.
 */
export declare const sendMessageTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            phoneNumber: {
                type: string;
                description: string;
            };
            content: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

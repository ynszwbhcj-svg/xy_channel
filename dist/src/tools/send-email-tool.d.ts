/**
 * XY send email tool - sends an email via 花瓣邮箱 on user's device.
 */
export declare const sendEmailTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            subject: {
                type: string;
                description: string;
            };
            to: {
                type: string;
                description: string;
            };
            body: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

/**
 * XiaoYi GUI tool - executes phone app interactions through GUI agent.
 * Simulates user interactions on phone screen (click, swipe, input, navigation, etc.)
 * to complete tasks that cannot be done through internet APIs.
 */
export declare const xiaoyiGuiTool: {
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
    execute(toolCallId: string, params: any): Promise<unknown>;
};

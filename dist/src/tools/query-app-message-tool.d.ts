/**
 * 查询指定时间范围内的设备通知消息。
 */
export declare const queryAppMessageTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            startTime: {
                type: string;
                description: string;
            };
            endTime: {
                type: string;
                description: string;
            };
            packageName: {
                type: string;
                description: string;
            };
            state: {
                type: string;
                description: string;
            };
        };
        required: any[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

/**
 * 获取指定时间范围内的全局待办任务列表。
 */
export declare const queryTodoTaskTool: {
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
            status: {
                type: string;
                description: string;
            };
        };
        required: any[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

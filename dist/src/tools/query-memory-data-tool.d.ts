/**
 * 查询存储在设备本地的结构化记忆数据。
 */
export declare const queryMemoryDataTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            category: {
                type: string;
                description: string;
            };
            subCategory: {
                description: string;
                oneOf: ({
                    type: string;
                    items?: undefined;
                } | {
                    type: string;
                    items: {
                        type: string;
                    };
                })[];
            };
        };
        required: any[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

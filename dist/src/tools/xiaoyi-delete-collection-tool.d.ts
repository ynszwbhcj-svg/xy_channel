/**
 * XY delete collection tool - deletes data from user's XiaoYi collection.
 */
export declare const xiaoyiDeleteCollectionTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            itemIds: {
                description: string;
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

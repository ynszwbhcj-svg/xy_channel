/**
 * XY collection tool - retrieves user's collection data from XiaoYi.
 * Returns personalized knowledge data saved in user's collection.
 */
export declare const xiaoyiCollectionTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            queryAll: {
                type: string;
                description: string;
            };
            query: {
                type: string;
                description: string;
            };
        };
        required: any[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

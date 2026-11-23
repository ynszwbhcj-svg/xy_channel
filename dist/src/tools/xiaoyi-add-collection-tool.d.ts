/**
 * XY add collection tool - adds data to user's XiaoYi collection.
 */
export declare const xiaoyiAddCollectionTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            content: {
                type: string;
                description: string;
            };
            uri: {
                type: string;
                description: string;
            };
            sourceAppBundleName: {
                type: string;
                description: string;
            };
            dataType: {
                type: string;
                description: string;
            };
            title: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

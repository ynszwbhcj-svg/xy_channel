export declare const displayA2UICardByPathTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            cardDSLPath: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(_toolCallId: string, params: any): Promise<{
        content: {
            type: string;
            text: string;
        }[];
    }>;
};

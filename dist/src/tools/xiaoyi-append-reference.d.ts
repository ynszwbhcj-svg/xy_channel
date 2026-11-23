export declare const xiaoyiAppendReferenceTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            references: {
                type: string;
                description: string;
                items: {
                    type: string;
                    properties: {
                        title: {
                            type: string;
                            description: string;
                        };
                        url: {
                            type: string;
                            description: string;
                        };
                        source: {
                            type: string;
                            description: string;
                        };
                        name: {
                            type: string;
                            description: string;
                        };
                        imageUrl: {
                            type: string;
                            description: string;
                        };
                    };
                    required: string[];
                };
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<{
        content: {
            type: string;
            text: string;
        }[];
    }>;
};

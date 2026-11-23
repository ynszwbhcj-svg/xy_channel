export declare const discoverCrossDevicesTool: {
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
    execute(_toolCallId: string, params: any): Promise<unknown>;
};

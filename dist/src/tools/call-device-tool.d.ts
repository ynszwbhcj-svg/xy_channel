export declare const callDeviceTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            toolName: {
                type: string;
                description: string;
            };
            arguments: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<any>;
};

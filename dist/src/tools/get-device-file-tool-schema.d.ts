export declare const getDeviceFileToolSchemaTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: "object";
        properties: {};
        required: string[];
    };
    execute(_toolCallId: string, _params: any): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
};

export declare const sendCrossDeviceTaskTool: {
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
            targetDeviceInfo: {
                type: string;
                description: string;
                properties: {
                    networkId: {
                        type: string;
                        description: string;
                    };
                    deviceName: {
                        type: string;
                        description: string;
                    };
                    deviceTypeId: {
                        type: string;
                        description: string;
                    };
                };
                required: string[];
            };
        };
        required: string[];
    };
    execute(_toolCallId: string, params: any): Promise<unknown>;
};

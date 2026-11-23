/**
 * huawei_id_tool 工具
 * 当 skill 依赖用户获取鉴权信息时，此工具协助用户快速获取鉴权信息。
 */
export declare const loginTokenTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            clientId: {
                type: string;
                description: string;
            };
            skillName: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

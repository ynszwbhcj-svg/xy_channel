/**
 * schema-tool-factory: 创建 get_xxx_tool_schema 工具。
 * 每个工具在被 LLM 调用时，返回其所包含的子工具的 name / description / parameters schema。
 */
interface SchemaToolOptions {
    name: string;
    label: string;
    description: string;
    tools: any[];
}
export declare function createSchemaTool(options: SchemaToolOptions): {
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
export {};

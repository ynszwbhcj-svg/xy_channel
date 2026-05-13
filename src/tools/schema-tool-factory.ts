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

export function createSchemaTool(options: SchemaToolOptions) {
  const { name, label, description, tools } = options;

  return {
    name,
    label,
    description,
    parameters: {
      type: "object" as const,
      properties: {},
      required: [] as string[],
    },
    async execute(_toolCallId: string, _params: any) {
      const schemas = tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(schemas, null, 2),
          },
        ],
      };
    },
  };
}

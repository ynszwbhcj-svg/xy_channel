/**
 * Agent-as-skill tool - invokes a registered agent by agentId as a skill.
 * The tool receives the agentId, query, and optional file attachments,
 * forwards the request to the target agent via WebSocket, and returns the result.
 */
export declare const agentAsSkillTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            agentId: {
                type: string;
                description: string;
            };
            query: {
                type: string;
                description: string;
            };
            filesInfo: {
                description: string;
                items: {
                    type: string;
                    properties: {
                        fileType: {
                            type: string;
                            description: string;
                            enum: string[];
                        };
                        fileId: {
                            type: string;
                            description: string;
                        };
                        fileUrl: {
                            type: string;
                            description: string;
                        };
                    };
                };
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

export declare const saveSelfEvolutionSkillTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            title: {
                type: string;
                description: string;
            };
            summary: {
                type: string;
                description: string;
            };
            when_to_use: {
                type: string;
                description: string;
            };
            rules: {
                type: string;
                items: {
                    type: string;
                };
                description: string;
            };
            examples: {
                type: string;
                items: {
                    type: string;
                };
                description: string;
            };
            tags: {
                type: string;
                items: {
                    type: string;
                };
                description: string;
            };
            supplement: {
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

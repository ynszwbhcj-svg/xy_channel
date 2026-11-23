/**
 * XY call phone tool - makes a phone call on user's device.
 * Requires phoneNumber parameter and optional slotId (0 for primary SIM, 1 for secondary SIM).
 */
export declare const callPhoneTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            phoneNumber: {
                type: string;
                description: string;
            };
            slotId: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

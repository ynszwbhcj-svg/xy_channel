/**
 * XY location tool - gets user's current location.
 * Returns WGS84 coordinates (latitude, longitude).
 */
export declare const locationTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {};
        required: any[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};

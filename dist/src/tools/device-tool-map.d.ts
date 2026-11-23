/** Known device type enum. */
export declare const DEVICE_TYPES: readonly ["car", "2in1", "phone", "web", "pad", "winpc", "smartWatch"];
export type DeviceType = (typeof DEVICE_TYPES)[number];
export declare function filterToolsByDevice(tools: any[], deviceType?: string): any[];

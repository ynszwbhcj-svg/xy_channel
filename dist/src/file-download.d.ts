/**
 * Download a file from URL to local path.
 */
export declare function downloadFile(url: string, destPath: string, maxBytes?: number): Promise<void>;
/**
 * Download files from A2A file parts.
 * Returns array of local file paths.
 */
export declare function downloadFilesFromParts(fileParts: Array<{
    name: string;
    mimeType: string;
    uri: string;
}>, tempDir?: string, options?: {
    maxImageBytes?: number;
}): Promise<Array<{
    path: string;
    name: string;
    mimeType: string;
    uri: string;
}>>;

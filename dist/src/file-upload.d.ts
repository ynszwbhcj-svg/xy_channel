/**
 * Service for uploading files to XY file storage.
 * Implements three-phase upload: prepare → upload → complete.
 */
export declare class XYFileUploadService {
    private baseUrl;
    private apiKey;
    private uid;
    constructor(baseUrl: string, apiKey: string, uid: string);
    /**
     * Upload a file using the three-phase process.
     * Returns the objectId (as fileId) for use in A2A messages.
     */
    uploadFile(filePath: string, objectType?: string): Promise<string>;
    /**
     * Upload a file and return its publicly accessible URL.
     * Uses completeAndQuery endpoint to get the file URL directly.
     */
    uploadFileAndGetUrl(filePath: string, objectType?: string): Promise<string>;
    /**
     * Upload a file and return both the objectId (fileId) and its publicly accessible URL.
     * Same flow as uploadFileAndGetUrl (completeAndQuery in phase 3).
     */
    uploadFileAndGetIdAndUrl(filePath: string, objectType?: string): Promise<{
        fileId: string;
        fileUrl: string;
    }>;
    /**
     * Upload a file and return a preview-able URL (needPreview=true).
     * Same as uploadFileAndGetUrl but adds needPreview flag to get a directly viewable URL.
     */
    uploadFileAndGetPreviewUrl(filePath: string, objectType?: string): Promise<string>;
    /**
     * Upload multiple files and return their file IDs.
     */
    uploadFiles(filePaths: string[], objectType?: string): Promise<Array<{
        filePath: string;
        fileId: string;
        fileName: string;
    }>>;
}

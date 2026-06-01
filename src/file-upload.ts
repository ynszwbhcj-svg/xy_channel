// Three-phase file upload service
// OSMS file upload implementation
import fetch from "node-fetch";
import fs from "fs/promises";
import os from "os";
import { logger } from "./utils/logger.js";
import path from "path";
import { calculateSHA256 } from "./utils/crypto.js";
import type {
  FileUploadPrepareRequest,
  FileUploadPrepareResponse,
  FileUploadCompleteRequest,
  FileUploadCompleteResponse,
} from "./types.js";

function isRemoteUrl(filePath: string): boolean {
  return filePath.startsWith("http://") || filePath.startsWith("https://");
}

async function downloadToTempFile(url: string): Promise<string> {
  logger.log(`[XY File Upload] Downloading remote file: ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download remote file: HTTP ${response.status}`);
  }
  const buffer = await response.buffer();
  const urlFileName = path.basename(new URL(url).pathname) || "download";
  const tempPath = path.join(os.tmpdir(), `xy-upload-${Date.now()}-${urlFileName}`);
  await fs.writeFile(tempPath, buffer);
  logger.log(`[XY File Upload] Downloaded to temp file: ${tempPath}`);
  return tempPath;
}

/**
 * Service for uploading files to XY file storage.
 * Implements three-phase upload: prepare → upload → complete.
 */
export class XYFileUploadService {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private uid: string
  ) {}

  /**
   * Upload a file using the three-phase process.
   * Returns the objectId (as fileId) for use in A2A messages.
   */
  async uploadFile(filePath: string, objectType: string = "TEMPORARY_MATERIAL_DOC"): Promise<string> {
    logger.log(`[XY File Upload] Starting file upload: ${filePath}`);

    let localFilePath = filePath;
    let isTempFile = false;

    try {
      // Handle remote URLs by downloading first
      if (isRemoteUrl(filePath)) {
        localFilePath = await downloadToTempFile(filePath);
        isTempFile = true;
      }

      // Read file
      const fileBuffer = await fs.readFile(localFilePath);
      const fileName = path.basename(localFilePath);
      const fileSha256 = calculateSHA256(fileBuffer);
      const fileSize = fileBuffer.length;

      // Phase 1: Prepare
      logger.log(`[XY File Upload] Phase 1: Prepare upload for ${fileName}`);
      const prepareResp = await fetch(`${this.baseUrl}/osms/v1/file/manager/prepare`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-uid": this.uid,
          "x-api-key": this.apiKey,
          "x-request-from": "openclaw",
        },
        body: JSON.stringify({
          objectType,
          fileName,
          fileSha256,
          fileSize,
          fileOwnerInfo: {
            uid: this.uid,
            teamId: this.uid,
          },
          useEdge: false,
        } as FileUploadPrepareRequest),
      });

      if (!prepareResp.ok) {
        throw new Error(`Prepare failed: HTTP ${prepareResp.status}`);
      }

      const prepareData = await prepareResp.json() as FileUploadPrepareResponse;

      if (prepareData.code !== "0") {
        throw new Error(`Prepare failed: ${prepareData.desc}`);
      }

      const { objectId, draftId, uploadInfos } = prepareData;

      // Phase 2: Upload
      logger.log(`[XY File Upload] Phase 2: Upload file data`);
      const uploadInfo = uploadInfos[0]; // Single-part upload

      const uploadResp = await fetch(uploadInfo.url, {
        method: uploadInfo.method,
        headers: uploadInfo.headers,
        body: fileBuffer,
      });

      if (!uploadResp.ok) {
        const uploadErrorText = await uploadResp.text();
        throw new Error(`Upload failed: HTTP ${uploadResp.status}`);
      }

      logger.log(`[XY File Upload] Upload complete`);

      // Phase 3: Complete
      logger.log(`[XY File Upload] Phase 3: Complete upload`);
      const completeResp = await fetch(`${this.baseUrl}/osms/v1/file/manager/complete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-uid": this.uid,
          "x-api-key": this.apiKey,
          "x-request-from": "openclaw",
        },
        body: JSON.stringify({
          objectId,
          draftId,
        } as FileUploadCompleteRequest),
      });

      if (!completeResp.ok) {
        throw new Error(`Complete failed: HTTP ${completeResp.status}`);
      }

      const completeData = await completeResp.json();

      logger.log(`[XY File Upload] File upload successful: ${fileName} → objectId=${objectId}`);
      return objectId;
    } catch (error) {
      logger.error(`[XY File Upload] File upload failed for ${filePath}:`, error);
      throw error;
    } finally {
      if (isTempFile) {
        try { await fs.unlink(localFilePath); } catch {}
      }
    }
  }

  /**
   * Upload a file and return its publicly accessible URL.
   * Uses completeAndQuery endpoint to get the file URL directly.
   */
  async uploadFileAndGetUrl(filePath: string, objectType: string = "TEMPORARY_MATERIAL_DOC"): Promise<string> {
    let localFilePath = filePath;
    let isTempFile = false;

    try {
      // Handle remote URLs by downloading first
      if (isRemoteUrl(filePath)) {
        localFilePath = await downloadToTempFile(filePath);
        isTempFile = true;
      }

      // Read file
      const fileBuffer = await fs.readFile(localFilePath);
      const fileName = path.basename(localFilePath);
      const fileSha256 = calculateSHA256(fileBuffer);
      const fileSize = fileBuffer.length;

      // Phase 1: Prepare
      logger.log(`[XY File Upload] Phase 1: Prepare upload for ${fileName}`);
      const prepareResp = await fetch(`${this.baseUrl}/osms/v1/file/manager/prepare`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-uid": this.uid,
          "x-api-key": this.apiKey,
          "x-request-from": "openclaw",
        },
        body: JSON.stringify({
          objectType,
          fileName,
          fileSha256,
          fileSize,
          fileOwnerInfo: {
            uid: this.uid,
            teamId: this.uid,
          },
          useEdge: false,
        } as FileUploadPrepareRequest),
      });

      if (!prepareResp.ok) {
        throw new Error(`Prepare failed: HTTP ${prepareResp.status}`);
      }

      const prepareData = await prepareResp.json() as FileUploadPrepareResponse;

      if (prepareData.code !== "0") {
        throw new Error(`Prepare failed: ${prepareData.desc}`);
      }

      const { objectId, draftId, uploadInfos } = prepareData;
      logger.log(`[XY File Upload] Prepare complete: objectId=${objectId}, draftId=${draftId}`);

      // Phase 2: Upload
      logger.log(`[XY File Upload] Phase 2: Upload file data`);
      const uploadInfo = uploadInfos[0]; // Single-part upload

      const uploadResp = await fetch(uploadInfo.url, {
        method: uploadInfo.method,
        headers: uploadInfo.headers,
        body: fileBuffer,
      });

      logger.log(`[XY File Upload] Upload response status: ${uploadResp.status}`);

      if (!uploadResp.ok) {
        const uploadErrorText = await uploadResp.text();
        throw new Error(`Upload failed: HTTP ${uploadResp.status}`);
      }

      logger.log(`[XY File Upload] Upload complete`);

      // Phase 3: CompleteAndQuery - get file URL
      logger.log(`[XY File Upload] Phase 3: CompleteAndQuery to get file URL`);
      const completeResp = await fetch(`${this.baseUrl}/osms/v1/file/manager/completeAndQuery`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-uid": this.uid,
          "x-api-key": this.apiKey,
          "x-request-from": "openclaw",
        },
        body: JSON.stringify({
          objectId,
          draftId,
        }),
      });

      if (!completeResp.ok) {
        throw new Error(`CompleteAndQuery failed: HTTP ${completeResp.status}`);
      }

      const completeData = await completeResp.json() as any;

      // Extract file URL from response
      const fileUrl = completeData?.fileDetailInfo?.url || "";
      if (!fileUrl) {
        throw new Error("No file URL returned from completeAndQuery");
      }

      logger.log(`[XY File Upload] File upload successful`);
      return fileUrl;
    } catch (error) {
      logger.error(`[XY File Upload] File upload with URL retrieval failed for ${filePath}:`, error);
      throw error;
    } finally {
      if (isTempFile) {
        try { await fs.unlink(localFilePath); } catch {}
      }
    }
  }

  /**
   * Upload multiple files and return their file IDs.
   */
  async uploadFiles(
    filePaths: string[],
    objectType: string = "TEMPORARY_MATERIAL_DOC"
  ): Promise<Array<{ filePath: string; fileId: string; fileName: string }>> {
    const results: Array<{ filePath: string; fileId: string; fileName: string }> = [];

    for (const filePath of filePaths) {
      try {
        const fileId = await this.uploadFile(filePath, objectType);
        results.push({
          filePath,
          fileId,
          fileName: path.basename(filePath),
        });
      } catch (error) {
        logger.error(`[XY File Upload] Failed to upload ${filePath}, skipping:`, error);
        // Continue with other files
      }
    }

    return results;
  }
}

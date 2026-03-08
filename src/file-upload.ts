// Three-phase file upload service
// OSMS file upload implementation
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import { calculateSHA256 } from "./utils/crypto.js";
import type {
  FileUploadPrepareRequest,
  FileUploadPrepareResponse,
  FileUploadCompleteRequest,
  FileUploadCompleteResponse,
} from "./types.js";

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
    console.log(`[XY File Upload] Starting file upload: ${filePath}`);

    try {
      // Read file
      const fileBuffer = await fs.readFile(filePath);
      const fileName = path.basename(filePath);
      const fileSha256 = calculateSHA256(fileBuffer);
      const fileSize = fileBuffer.length;

      // Phase 1: Prepare
      console.log(`[XY File Upload] Phase 1: Prepare upload for ${fileName}`);
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
      console.log(`[XY File Upload] Prepare response:`, JSON.stringify(prepareData, null, 2));

      if (prepareData.code !== "0") {
        throw new Error(`Prepare failed: ${prepareData.desc}`);
      }

      const { objectId, draftId, uploadInfos } = prepareData;
      console.log(`[XY File Upload] Prepare complete: objectId=${objectId}, draftId=${draftId}`);

      // Phase 2: Upload
      console.log(`[XY File Upload] Phase 2: Upload file data`);
      const uploadInfo = uploadInfos[0]; // Single-part upload

      const uploadResp = await fetch(uploadInfo.url, {
        method: uploadInfo.method,
        headers: uploadInfo.headers,
        body: fileBuffer,
      });

      console.log(`[XY File Upload] Upload response status: ${uploadResp.status}, url: ${uploadInfo.url}`);
      console.log(`[XY File Upload] Upload response headers:`, JSON.stringify(Object.fromEntries(uploadResp.headers.entries()), null, 2));

      if (!uploadResp.ok) {
        const uploadErrorText = await uploadResp.text();
        console.log(`[XY File Upload] Upload error response:`, uploadErrorText);
        throw new Error(`Upload failed: HTTP ${uploadResp.status}`);
      }

      console.log(`[XY File Upload] Upload complete`);

      // Phase 3: Complete
      console.log(`[XY File Upload] Phase 3: Complete upload`);
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
      console.log(`[XY File Upload] Complete response:`, JSON.stringify(completeData, null, 2));

      console.log(`[XY File Upload] File upload successful: ${fileName} → objectId=${objectId}`);
      return objectId;
    } catch (error) {
      console.error(`[XY File Upload] File upload failed for ${filePath}:`, error);
      return "";
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
        console.error(`[XY File Upload] Failed to upload ${filePath}, skipping:`, error);
        // Continue with other files
      }
    }

    return results;
  }
}

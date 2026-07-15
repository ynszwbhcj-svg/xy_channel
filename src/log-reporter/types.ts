// Type definitions for log reporter framework

/** Configuration for a single log monitor (hardcoded) */
export interface LogMonitorConfig {
  /** File path with date wildcards: {year}, {month}, {day}, {year-month-day}, {year}{month}{day}, {hour}, {minute}, {second} */
  path: string;
  /** Business type for reporting */
  businessType: string;
  /** Whether to parse JSON log lines (openclaw gateway format) */
  jsonParse: boolean;
}

/** Cursor state for a single log file */
export interface FileCursor {
  /** Byte offset we last read to */
  lastSize: number;
  /** Cumulative line count read so far */
  lastLine: number;
  /** File mtime (ms) at last read */
  lastModified: number;
}

/** Persisted cursor store structure */
export interface CursorStore {
  files: Record<string, FileCursor>;
}

/** Result of scanning a single log file */
export interface ScanResult {
  /** Resolved absolute file path */
  filePath: string;
  /** Business type from monitor config */
  businessType: string;
  /** The new log lines (incremental content, may be parsed/formatted) */
  content: string;
  /** Updated cursor to persist after successful upload */
  newCursor: FileCursor;
}

/** Options passed to startLogReporter */
export interface LogReporterOptions {
  /** File upload service instance (from xy_channel) */
  uploadService: UploadService;
}

/** Minimal interface for the upload service (duck-typed from XYFileUploadService) */
export interface UploadService {
  uploadFileAndGetUrl(filePath: string, objectType?: string): Promise<string>;
}

/** A single log file entry in the report payload */
export interface ReportLogFileEntry {
  businessType: string;
  fileUrl: string;
}

/** Report payload sent to the sync API */
export interface ReportPayload {
  instanceId: string;
  logFiles: ReportLogFileEntry[];
}

/** Environment config read from .xiaoyienv */
export interface LogReporterEnv {
  serviceUrl: string;
  apiKey: string;
  uid: string;
}

// Type definitions for log reporter framework

/** Configuration for a single log file to monitor */
export interface LogFileConfig {
  /** File path with optional date wildcards: {year}, {month}, {day}, {year-month-day}, {year}{month}{day} */
  path: string;
  /** Logical name used in .bak filename and reporting */
  name: string;
}

/** Top-level log reporter configuration (loaded from JSON file) */
export interface LogReporterConfig {
  /** Scan interval in milliseconds (default: 600000 = 10 min) */
  scanIntervalMs: number;
  /** Directory for .bak files and cursor state */
  bakDir: string;
  /** Report server URL (mock for now) */
  reportUrl: string;
  /** Log files to monitor */
  logFiles: LogFileConfig[];
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
  /** Logical name from config */
  name: string;
  /** The new log lines (incremental content) */
  content: string;
  /** Start line number (1-based, inclusive) */
  lineStart: number;
  /** End line number (1-based, inclusive) */
  lineEnd: number;
  /** Number of new lines */
  newLineCount: number;
  /** Updated cursor to persist after successful upload */
  newCursor: FileCursor;
}

/** Options passed to startLogReporter */
export interface LogReporterOptions {
  /** Absolute path to the JSON config file */
  configPath: string;
  /** File upload service instance (from xy_channel) */
  uploadService: UploadService;
}

/** Minimal interface for the upload service (duck-typed from XYFileUploadService) */
export interface UploadService {
  uploadFileAndGetUrl(filePath: string, objectType?: string): Promise<string>;
}

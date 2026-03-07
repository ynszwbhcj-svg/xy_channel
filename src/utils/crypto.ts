// Cryptographic utilities
import crypto from "crypto";

/**
 * Calculate SHA256 hash of a buffer.
 */
export function calculateSHA256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Calculate SHA256 hash of a string.
 */
export function calculateSHA256String(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// CSPL Hook 工具函数

import { MAX_TEXT_LENGTH, regex, SECURITY_NOTICE} from "./constants.js";

export function filterText(text: string): string {
  if (!text) return "";
  return text.replace(new RegExp(regex.source, "g"), "");
}

export function validateAndTruncateText(
  text: string,
  maxLength: number,
): { text: string; truncated: boolean } {
  if (text.length > maxLength) {
    const halfMaxLength = Math.floor(maxLength / 2);
    const startText = text.substring(0, halfMaxLength);
    const endText = text.substring(text.length - halfMaxLength);
    return { text: startText + endText, truncated: true };
  }
  return { text, truncated: false };
}

export function extractResultText(event: any, toolName: string): string {
  const resultTexts: string[] = [];

  if (toolName === "web_fetch") {
    if (event.result?.details?.text) {
      let text = event.result.details.text;
      text = text.replace(SECURITY_NOTICE, '');
      resultTexts.push(text);
    }
    return resultTexts.length > 0 ? resultTexts.join("; ") : "";
  }

  if (event.result?.content && Array.isArray(event.result.content)) {
    for (const item of event.result.content) {
      if (item?.text) {
        resultTexts.push(item.text);
      }
    }
  }

  return resultTexts.length > 0 ? resultTexts.join("; ") : "";
}

export function processText(resultText: string): string {
  const questionText = filterText(resultText);
  const { text: finalText } = validateAndTruncateText(questionText, MAX_TEXT_LENGTH);
  return finalText;
}

export function parseSecurityResult(response: any): { status: "ACCEPT" | "REJECT" } {
  if (response === null || response === undefined) {
    throw new Error("Response is null or undefined");
  }
  if (!response.data || typeof response.data !== "object") {
    throw new Error("Response.data is missing or not an object");
  }
  const securityResult = response.data.securityResult;
  if (typeof securityResult !== "string") {
    throw new Error("Response.data.securityResult is missing or not a string");
  }
  if (securityResult !== securityResult.trim()) {
    throw new Error("Response.data.securityResult contains leading or trailing spaces");
  }
  if (securityResult !== "ACCEPT" && securityResult !== "REJECT") {
    throw new Error(`Response.data.securityResult must be "ACCEPT" or "REJECT". Actual: "${securityResult}"`);
  }
  return { status: securityResult };
}

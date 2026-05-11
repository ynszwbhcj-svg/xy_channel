#!/usr/bin/env node
/**
 * Refactor tool files to use sessionKey + requireSession pattern.
 * Run from xy_channel root: node scripts/refactor-tools.mjs
 */
import { readFileSync, writeFileSync } from "fs";
import { globSync } from "fs";

const files = [
  "src/tools/calendar-tool.ts",
  "src/tools/call-phone-tool.ts",
  "src/tools/create-alarm-tool.ts",
  "src/tools/delete-alarm-tool.ts",
  "src/tools/modify-note-tool.ts",
  "src/tools/note-tool.ts",
  "src/tools/query-app-message-tool.ts",
  "src/tools/query-memory-data-tool.ts",
  "src/tools/query-todo-task-tool.ts",
  "src/tools/save-file-to-phone-tool.ts",
  "src/tools/save-media-to-gallery-tool.ts",
  "src/tools/search-alarm-tool.ts",
  "src/tools/search-calendar-tool.ts",
  "src/tools/search-contact-tool.ts",
  "src/tools/search-email-tool.ts",
  "src/tools/search-file-tool.ts",
  "src/tools/search-message-tool.ts",
  "src/tools/search-note-tool.ts",
  "src/tools/search-photo-gallery-tool.ts",
  "src/tools/send-email-tool.ts",
  "src/tools/send-message-tool.ts",
  "src/tools/upload-file-tool.ts",
  "src/tools/upload-photo-tool.ts",
  "src/tools/xiaoyi-add-collection-tool.ts",
  "src/tools/xiaoyi-collection-tool.ts",
  "src/tools/xiaoyi-delete-collection-tool.ts",
];

for (const file of files) {
  let content = readFileSync(file, "utf-8");

  // 1. Add requireSession call at the start of execute()
  // Find the execute function and add session lookup right after the opening brace
  content = content.replace(
    /async execute\(toolCallId: string, params: any\) \{\n(\s*)/,
    (match, indent) => {
      return `async execute(toolCallId: string, params: any) {\n${indent}const session = requireSession(sessionKey);\n`;
    }
  );

  // 2. Replace variable references in execute body
  // sessionId → session.a2aSessionId  (but NOT in string literals or log messages)
  // config → session.config
  // taskId → session.taskId
  // messageId → session.messageId

  // In sendCommand calls and similar structured objects:
  // Replace lines like:  config: session.config, (already done by sed for the simple case)
  // We need to handle multi-line object patterns

  // Pattern: sendCommand({ followed by lines with the variables
  content = content.replace(
    /sendCommand\(\{\n([\s\S]*?)\}\)/g,
    (match, body) => {
      let newBody = body;
      newBody = newBody.replace(/^\s*config: session\.config,\s*$/m, "        config: session.config,");
      newBody = newBody.replace(/^\s*sessionId: session\.a2aSessionId,\s*$/m, "        sessionId: session.a2aSessionId,");
      newBody = newBody.replace(/^\s*taskId: session\.taskId,\s*$/m, "        taskId: session.taskId,");
      newBody = newBody.replace(/^\s*messageId: session\.messageId,\s*$/m, "        messageId: session.messageId,");
      return `sendCommand({\n${newBody}})`;
    }
  );

  // Handle sendA2AResponse pattern
  content = content.replace(
    /sendA2AResponse\(\{\n([\s\S]*?)\}\)/g,
    (match, body) => {
      let newBody = body;
      newBody = newBody.replace(/^\s*config: session\.config,\s*$/m, "      config: session.config,");
      newBody = newBody.replace(/^\s*sessionId: session\.a2aSessionId,\s*$/m, "      sessionId: session.a2aSessionId,");
      newBody = newBody.replace(/^\s*taskId: session\.taskId,\s*$/m, "      taskId: session.taskId,");
      newBody = newBody.replace(/^\s*messageId: session\.messageId,\s*$/m, "      messageId: session.messageId,");
      return `sendA2AResponse({\n${newBody}})`;
    }
  );

  writeFileSync(file, content, "utf-8");
  console.log(`Updated: ${file}`);
}

console.log("Done!");

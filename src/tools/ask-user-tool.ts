import { v4 as uuidv4 } from "uuid";
import { sendCommand } from "../formatter.js";
import { getCachedXYWebSocketManager } from "../transport/client.js";
import type { AskUserResponse } from "../types.js";
import { logger } from "../utils/logger.js";
import { getCurrentSessionContext } from "./session-manager.js";
import { isToolVisibleForAppVersion } from "./tool-visibility.js";

const ASK_USER_TIMEOUT_SECONDS = 120;
const ASK_USER_TIMEOUT_MS = ASK_USER_TIMEOUT_SECONDS * 1000;

class ToolInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

function assertOptionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new ToolInputError(`${field} 必须是布尔值`);
  }
}

function normalizeQuestions(input: unknown): Array<Record<string, any>> {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ToolInputError("questions 必须是非空数组");
  }

  const questionIds = new Set<string>();
  return input.map((rawQuestion: any, index: number) => {
    if (!rawQuestion || typeof rawQuestion !== "object") {
      throw new ToolInputError(`questions[${index}] 必须是对象`);
    }
    if (typeof rawQuestion.question !== "string" || !rawQuestion.question.trim()) {
      throw new ToolInputError(`questions[${index}].question 必须是非空字符串`);
    }
    if (rawQuestion.header !== undefined && typeof rawQuestion.header !== "string") {
      throw new ToolInputError(`questions[${index}].header 必须是字符串`);
    }
    assertOptionalBoolean(rawQuestion.multi_select, `questions[${index}].multi_select`);

    const questionId = rawQuestion.question_id ?? `q_${String(index + 1).padStart(3, "0")}`;
    if (typeof questionId !== "string" || !questionId.trim()) {
      throw new ToolInputError(`questions[${index}].question_id 必须是非空字符串`);
    }
    if (questionIds.has(questionId)) {
      throw new ToolInputError(`question_id 不能重复: ${questionId}`);
    }
    questionIds.add(questionId);

    if (!Array.isArray(rawQuestion.options) || rawQuestion.options.length === 0) {
      throw new ToolInputError(`questions[${index}].options 必须是非空数组`);
    }
    const options = rawQuestion.options.map((rawOption: any, optionIndex: number) => {
      if (!rawOption || typeof rawOption !== "object") {
        throw new ToolInputError(`questions[${index}].options[${optionIndex}] 必须是对象`);
      }
      if (typeof rawOption.label !== "string" || !rawOption.label.trim()) {
        throw new ToolInputError(`questions[${index}].options[${optionIndex}].label 必须是非空字符串`);
      }
      if (rawOption.description !== undefined && typeof rawOption.description !== "string") {
        throw new ToolInputError(`questions[${index}].options[${optionIndex}].description 必须是字符串`);
      }
      assertOptionalBoolean(
        rawOption.recommended,
        `questions[${index}].options[${optionIndex}].recommended`,
      );
      return {
        label: rawOption.label,
        ...(rawOption.description !== undefined ? { description: rawOption.description } : {}),
        ...(rawOption.recommended !== undefined ? { recommended: rawOption.recommended } : {}),
      };
    });

    let tool: Record<string, any> | undefined;
    if (rawQuestion.tool !== undefined) {
      const rawTool = rawQuestion.tool;
      if (!rawTool || typeof rawTool !== "object") {
        throw new ToolInputError(`questions[${index}].tool 必须是对象`);
      }
      if (typeof rawTool.tool_name !== "string" || !rawTool.tool_name.trim()) {
        throw new ToolInputError(`questions[${index}].tool.tool_name 必须是非空字符串`);
      }
      if (!rawTool.tool_args || typeof rawTool.tool_args !== "object" || Array.isArray(rawTool.tool_args)) {
        throw new ToolInputError(`questions[${index}].tool.tool_args 必须是对象`);
      }
      tool = {
        tool_name: rawTool.tool_name,
        tool_args: rawTool.tool_args,
      };
    }

    let textInput: Record<string, any> | undefined;
    if (rawQuestion.text_input !== undefined) {
      const rawTextInput = rawQuestion.text_input;
      if (!rawTextInput || typeof rawTextInput !== "object") {
        throw new ToolInputError(`questions[${index}].text_input 必须是对象`);
      }
      if (typeof rawTextInput.enabled !== "boolean") {
        throw new ToolInputError(`questions[${index}].text_input.enabled 必须是布尔值`);
      }
      if (rawTextInput.placeholder !== undefined && typeof rawTextInput.placeholder !== "string") {
        throw new ToolInputError(`questions[${index}].text_input.placeholder 必须是字符串`);
      }
      assertOptionalBoolean(rawTextInput.required, `questions[${index}].text_input.required`);
      textInput = {
        enabled: rawTextInput.enabled,
        ...(rawTextInput.placeholder !== undefined ? { placeholder: rawTextInput.placeholder } : {}),
        required: rawTextInput.required ?? false,
      };
    }

    return {
      question_id: questionId,
      ...(rawQuestion.header !== undefined ? { header: rawQuestion.header } : {}),
      question: rawQuestion.question,
      multi_select: rawQuestion.multi_select ?? false,
      ...(tool ? { tool } : {}),
      options,
      ...(textInput ? { text_input: textInput } : {}),
    };
  });
}

/** 通过 ToolExecute.Invoke 展示选择卡片，并等待 AgentEvent.InvokeRsp 用户反馈。 */
export const askUserTool = {
  name: "ask_user",
  label: "Ask User",
  description: `当缺少继续完成任务所需的信息，且存在若干合理选项时，向用户展示一个或多个选择问题。
每个问题可提供选项、是否多选以及自定义文本输入；工具会等待并返回用户选择的 selected_options、自定义 custom_text 或 user_cancel 取消状态，再根据结果继续决策。
仅在当前信息不足以继续时调用，不要询问上下文中已经明确的信息。等待超时时间为120秒，超时或取消后不要重复调用同一问题。`,
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        description: "需要用户回答的问题列表",
        items: {
          type: "object",
          properties: {
            question_id: {
              type: "string",
              description: "问题唯一ID；省略时按顺序生成 q_001、q_002……",
            },
            header: { type: "string", description: "问题卡片标题" },
            question: { type: "string", description: "需要用户回答的问题" },
            multi_select: { type: "boolean", description: "是否允许多选，默认 false" },
            tool: {
              type: "object",
              description: "可选的敏感工具参数绑定",
              properties: {
                tool_name: { type: "string" },
                tool_args: { type: "object" },
              },
              required: ["tool_name", "tool_args"],
            },
            options: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "选项展示文本" },
                  description: { type: "string", description: "选项补充说明" },
                  recommended: { type: "boolean", description: "是否推荐该选项" },
                },
                required: ["label"],
              },
            },
            text_input: {
              type: "object",
              description: "可选的自定义文本输入配置",
              properties: {
                enabled: { type: "boolean" },
                placeholder: { type: "string" },
                required: { type: "boolean", description: "是否必须填写，默认 false" },
              },
              required: ["enabled"],
            },
          },
          required: ["question", "options"],
        },
      },
    },
    required: ["questions"],
  },

  async execute(toolCallId: string, params: any) {
    const context = getCurrentSessionContext();
    if (!context) {
      throw new Error("ask_user 需要有效的用户会话上下文");
    }
    if (!isToolVisibleForAppVersion(askUserTool.name, context.appVer)) {
      throw new Error("当前客户端版本不支持 ask_user，请直接通过文字询问用户");
    }

    const questions = normalizeQuestions(params?.questions);
    const askUserId = uuidv4();
    const expiresAt = Math.floor(Date.now() / 1000) + ASK_USER_TIMEOUT_SECONDS;
    const command = {
      header: {
        namespace: "ToolExecute",
        name: "Invoke",
      },
      payload: {
        source: "ask_user_interrupt",
        expires_at: expiresAt,
        ask_user_id: askUserId,
        questions,
      },
    };

    const wsManager = getCachedXYWebSocketManager();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        wsManager.off("ask-user-response", handler);
      };
      const timeout = setTimeout(() => {
        cleanup();
        logger.error(`[ASK-USER] 等待用户选择超时（${ASK_USER_TIMEOUT_SECONDS}秒）`, { toolCallId, askUserId });
        reject(new Error(`等待用户选择超时（${ASK_USER_TIMEOUT_SECONDS}秒）`));
      }, ASK_USER_TIMEOUT_MS);

      const handler = (event: AskUserResponse) => {
        if (event?.ask_user_id !== askUserId) return;
        cleanup();
        logger.log(`[ASK-USER] 收到用户反馈 askUserId=${askUserId} userCancel=${event.user_cancel === true}`);
        resolve({
          content: [
            {
              type: "text",
              text: JSON.stringify(event),
            },
          ],
        });
      };

      wsManager.on("ask-user-response", handler);
      sendCommand({
        config: context.config,
        sessionId: context.sessionId,
        taskId: context.taskId,
        messageId: context.messageId,
        command,
        toolCallId,
      }).catch((error) => {
        cleanup();
        reject(error);
      });
    });
  },
};

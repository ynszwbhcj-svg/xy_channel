import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pushBroadcast: vi.fn(),
  savePushData: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../src/conversation/outbound-gateway.js", () => ({
  pushBroadcast: mocks.pushBroadcast,
}));

vi.mock("../src/utils/pushdata-manager.js", () => ({
  savePushData: mocks.savePushData,
}));

vi.mock("../src/utils/logger.js", () => ({
  logger: {
    log: mocks.log,
    warn: mocks.warn,
    error: mocks.error,
  },
}));

import {
  captureCronAssistantText,
  closeCronTurn,
  gateCronSendText,
  isCronAnnounceTarget,
  notifyCronAgentEnd,
  notifyCronDetected,
} from "../src/conversation/cron-buffer.js";

const config = { defaultSessionId: "default-session" } as any;
const jobIds = new Set<string>();

function openCronTurn(jobId: string): void {
  jobIds.add(jobId);
  notifyCronDetected(jobId, `title-${jobId}`);
}

describe("cron assistant text aggregation", () => {
  beforeEach(() => {
    mocks.savePushData.mockResolvedValue("push-data-id");
    mocks.pushBroadcast.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const jobId of jobIds) closeCronTurn(jobId, "test-cleanup");
    jobIds.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("merges pre-tool assistant content with the final announce without duplicating the tail", () => {
    const jobId = "job-final-announce";
    openCronTurn(jobId);

    captureCronAssistantText(jobId, "今日推荐正文");
    captureCronAssistantText(jobId, "今日推荐正文\n\n包含全部推荐理由");
    captureCronAssistantText(jobId, "补充参考来源");
    notifyCronAgentEnd(jobId);

    const result = gateCronSendText("补充参考来源", true, config);

    expect(result).toMatchObject({
      gate: "announce",
      jobId,
      text: "今日推荐正文\n\n包含全部推荐理由\n\n补充参考来源",
      meta: { jobId, jobTitle: `title-${jobId}` },
    });
  });

  it("does not duplicate a single assistant answer when announce repeats it", () => {
    const jobId = "job-single-answer";
    openCronTurn(jobId);
    captureCronAssistantText(jobId, "唯一完整回答");
    notifyCronAgentEnd(jobId);

    const result = gateCronSendText("唯一完整回答", true, config);

    expect(result.gate).toBe("announce");
    expect(result.text).toBe("唯一完整回答");
  });

  it("uses a same-message replacement frame instead of retaining superseded text", () => {
    const jobId = "job-replacement";
    openCronTurn(jobId);
    captureCronAssistantText(jobId, "正在处理");
    captureCronAssistantText(jobId, "最终回答", true);
    notifyCronAgentEnd(jobId);

    const result = gateCronSendText("最终回答", true, config);

    expect(result.text).toBe("最终回答");
  });

  it("keeps assistant and message-tool text in their original order", () => {
    const jobId = "job-message-order";
    openCronTurn(jobId);
    captureCronAssistantText(jobId, "前序正文");

    expect(gateCronSendText("message 工具推送", false, config).gate).toBe("swallow");
    captureCronAssistantText(jobId, "后续补充");
    notifyCronAgentEnd(jobId);

    const result = gateCronSendText("后续补充", true, config);
    expect(result.text).toBe("前序正文\n\nmessage 工具推送\n\n后续补充");
  });

  it("keeps concurrent jobs' assistant buffers isolated", () => {
    openCronTurn("job-a");
    openCronTurn("job-b");
    captureCronAssistantText("job-a", "任务 A 正文");
    captureCronAssistantText("job-b", "任务 B 正文");
    captureCronAssistantText("job-a", "任务 A 结尾");
    captureCronAssistantText("job-b", "任务 B 结尾");
    notifyCronAgentEnd("job-a");
    notifyCronAgentEnd("job-b");

    const resultA = gateCronSendText("任务 A 结尾", true, config);
    closeCronTurn("job-a", "test-announce-a");
    const resultB = gateCronSendText("任务 B 结尾", true, config);

    expect(resultA.text).toBe("任务 A 正文\n\n任务 A 结尾");
    expect(resultA.meta?.jobId).toBe("job-a");
    expect(resultB.text).toBe("任务 B 正文\n\n任务 B 结尾");
    expect(resultB.meta?.jobId).toBe("job-b");
  });

  it("flushes full message-tool content and the final assistant summary when announce is suppressed", async () => {
    vi.useFakeTimers();
    const jobId = "job-no-announce";
    const fullReport = "资讯正文".repeat(300);
    const finalSummary = "以上为完整资讯简报。";
    openCronTurn(jobId);

    expect(gateCronSendText(fullReport, true, config).gate).toBe("swallow");
    captureCronAssistantText(jobId, finalSummary);
    notifyCronAgentEnd(jobId);
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();

    const merged = `${fullReport}\n\n${finalSummary}`;
    expect(mocks.savePushData).toHaveBeenCalledWith(merged, {
      cronJobId: jobId,
      cronTitle: `title-${jobId}`,
    });
    expect(mocks.pushBroadcast).toHaveBeenCalledWith(expect.objectContaining({
      text: merged.slice(0, 1000),
      pushDataId: "push-data-id",
      cronJobId: jobId,
      cronTitle: `title-${jobId}`,
    }));
  });
});

describe("isCronAnnounceTarget", () => {
  beforeEach(() => {
    mocks.savePushData.mockResolvedValue("push-data-id");
    mocks.pushBroadcast.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const jobId of jobIds) closeCronTurn(jobId, "test-cleanup");
    jobIds.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns true for empty target", () => {
    expect(isCronAnnounceTarget(undefined)).toBe(true);
    expect(isCronAnnounceTarget("")).toBe(true);
  });

  it("returns false for real conversation target with ::", () => {
    expect(isCronAnnounceTarget("sessionId::taskId")).toBe(false);
  });

  it("returns false for placeholder target when no cron turn exists", () => {
    expect(isCronAnnounceTarget("default")).toBe(false);
    expect(isCronAnnounceTarget("00000000")).toBe(false);
  });

  it("returns false for placeholder target when cron turn is still active", () => {
    const jobId = "job-active-turn";
    openCronTurn(jobId);
    // agentEnded = false（run 还在跑）
    expect(isCronAnnounceTarget("00000000")).toBe(false);
    expect(isCronAnnounceTarget("default")).toBe(false);
  });

  it("returns true for placeholder target when cron turn has ended", () => {
    const jobId = "job-ended-turn";
    openCronTurn(jobId);
    notifyCronAgentEnd(jobId);
    // agentEnded = true（run 已结束）
    expect(isCronAnnounceTarget("00000000")).toBe(true);
    expect(isCronAnnounceTarget("default")).toBe(true);
  });

  it("returns false for real conversation target even with ended cron turn", () => {
    const jobId = "job-ended-with-real-target";
    openCronTurn(jobId);
    notifyCronAgentEnd(jobId);
    expect(isCronAnnounceTarget("sessionId::taskId")).toBe(false);
  });
});

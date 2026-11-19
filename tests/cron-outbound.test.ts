import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gateCronSendText: vi.fn(),
  closeCronTurn: vi.fn(),
  isCronAnnounceTarget: vi.fn(),
  savePushData: vi.fn(),
  pushBroadcast: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  resolveXYConfig: () => ({ defaultSessionId: "default-session" }),
}));

vi.mock("../src/conversation/cron-buffer.js", () => ({
  gateCronSendText: mocks.gateCronSendText,
  closeCronTurn: mocks.closeCronTurn,
  isCronAnnounceTarget: mocks.isCronAnnounceTarget,
}));

vi.mock("../src/conversation/outbound-gateway.js", () => ({
  pushBroadcast: mocks.pushBroadcast,
  sendWsFrame: vi.fn(),
}));

vi.mock("../src/tools/session-manager.js", () => ({
  getCurrentSessionContext: () => undefined,
}));

vi.mock("../src/conversation/conversation-manager.js", () => ({
  getWaitState: () => undefined,
  addCompletionText: vi.fn(),
}));

vi.mock("../src/utils/pushdata-manager.js", () => ({
  savePushData: mocks.savePushData,
}));

vi.mock("../src/utils/logger.js", () => ({
  logger: {
    log: mocks.log,
    warn: mocks.warn,
    error: mocks.error,
    withContext: () => ({ log: mocks.log, warn: mocks.warn, error: mocks.error }),
  },
}));

import { xyOutbound } from "../src/dispatch/outbound.js";

describe("cron outbound full-text delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.savePushData.mockResolvedValue("push-data-id");
    mocks.pushBroadcast.mockResolvedValue(undefined);
    // 默认模拟 isCronAnnounceTarget 行为：空或 "default" 返回 true，其余 false
    mocks.isCronAnnounceTarget.mockImplementation((to: string | undefined) => !to || to === "default");
  });

  it("persists and pushes the merged cron text instead of the announce tail", async () => {
    const mergedText = "完整推荐正文\n\n补充参考来源";
    mocks.gateCronSendText.mockReturnValue({
      gate: "announce",
      text: mergedText,
      jobId: "job-1",
      meta: { jobId: "job-1", jobTitle: "每日推荐" },
    });

    await xyOutbound.sendText({
      cfg: {},
      to: "default",
      text: "补充参考来源",
      accountId: "default",
    });

    expect(mocks.savePushData).toHaveBeenCalledWith(mergedText, {
      cronJobId: "job-1",
      cronTitle: "每日推荐",
    });
    expect(mocks.pushBroadcast).toHaveBeenCalledWith(expect.objectContaining({
      text: mergedText,
      title: "完整推荐正文",
      pushDataId: "push-data-id",
      cronJobId: "job-1",
      cronTitle: "每日推荐",
    }));
    expect(mocks.closeCronTurn).toHaveBeenCalledWith("job-1", "announce-delivered");
  });

  it("routes to=00000000 through isCronAnnounceTarget and merges full text when gate returns announce", async () => {
    // 复现线上事故场景：openclaw cron announce 的 to 是 "00000000"，
    // isCronAnnounceTarget 识别为 announce，gate 返回合并全文。
    const fullReview = "A股11月2日收评：创业板指反弹收涨1.87%，全市场涨停个股超百只...（完整复盘正文）";
    const closingText = "引用工具临时降级，正文已归档。";
    const mergedText = `${fullReview}\n\n${closingText}`;

    mocks.isCronAnnounceTarget.mockReturnValue(true);
    mocks.gateCronSendText.mockReturnValue({
      gate: "announce",
      text: mergedText,
      jobId: "job-cron-00000000",
      meta: { jobId: "job-cron-00000000", jobTitle: "A股每日收盘复盘" },
    });

    await xyOutbound.sendText({
      cfg: {},
      to: "00000000",
      text: closingText,
      accountId: "default",
    });

    // 验证 isCronAnnounceTarget 被用来判定 announceLike
    expect(mocks.isCronAnnounceTarget).toHaveBeenCalledWith("00000000");
    // 验证 gateCronSendText 收到的 announceLike=true
    expect(mocks.gateCronSendText).toHaveBeenCalledWith(closingText, true, expect.anything());
    // 验证最终保存的是合并全文，不是 391 字降级说明
    expect(mocks.savePushData).toHaveBeenCalledWith(mergedText, {
      cronJobId: "job-cron-00000000",
      cronTitle: "A股每日收盘复盘",
    });
    expect(mocks.pushBroadcast).toHaveBeenCalledWith(expect.objectContaining({
      text: mergedText.length > 1000 ? mergedText.slice(0, 1000) : mergedText,
      pushDataId: "push-data-id",
      cronJobId: "job-cron-00000000",
      cronTitle: "A股每日收盘复盘",
    }));
    expect(mocks.closeCronTurn).toHaveBeenCalledWith("job-cron-00000000", "announce-delivered");
  });
});

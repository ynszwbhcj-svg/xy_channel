// 文件消息延迟下发注册表（高版本链路）。
//
// send_file_to_user / 跨设备任务结果回传等场景在 turn 中途产生待下发文件，
// 但协议要求文件帧在【最后一个正文帧之后、引用（reference）帧之前】统一下发 ——
// 工具调用点立即发送会插队在正文流中间。因此工具侧只攒批到本注册表（上传在
// 调用点完成，仅帧下发延后），由 turn 收尾序列（reply-dispatcher onIdle 的
// terminal-text-complete 之后 / conversation-manager.deliverSubagentFinalResult
// 的正文完成帧之后）统一取出下发。低版本链路 / cron 上下文不经过本注册表
// （工具内直接发送，见 send-file-to-user-tool）。
//
// 生命周期与 pending-references 一致：completeTask / deleteSession 时随任务
// 释放。下发即 drain（读取并清空），终帧后不残留。
//
// 叶子模块：无依赖，formatter / conversation-manager / reply-dispatcher /
// tools 均可安全 import。

/** 待下发文件条目（上传已完成，fileId/fileUrl 在工具调用点就绪）。 */
export interface PendingFileItem {
  fileName: string;
  /** MIME 类型（跨设备回传的文件卡片可能缺失，帧内不携带）。 */
  mimeType?: string;
  fileId: string;
  /** 公网 URL（跨设备回传的文件卡片可能只有 fileId，无 URL）。 */
  fileUrl?: string;
}

/** taskId → 本 turn 待下发的文件条目（按工具调用顺序追加）。 */
const pendingFilesByTask = new Map<string, PendingFileItem[]>();

/** 攒批待下发文件（工具调用点调用）。同一 turn 多次调用累加到同一列表。 */
export function appendPendingFiles(taskId: string, items: PendingFileItem[]): void {
  if (items.length === 0) return;
  const existing = pendingFilesByTask.get(taskId);
  if (existing) {
    existing.push(...items);
  } else {
    pendingFilesByTask.set(taskId, [...items]);
  }
}

/** 读取并清空待下发文件（收尾序列 flush 时调用）；无待下发返回空数组。 */
export function drainPendingFiles(taskId: string): PendingFileItem[] {
  const items = pendingFilesByTask.get(taskId);
  if (!items || items.length === 0) return [];
  pendingFilesByTask.delete(taskId);
  return items;
}

/** 释放指定 taskId 的待下发文件（任务链清理 / 会话销毁时调用）。幂等。 */
export function releasePendingFiles(taskId: string): void {
  pendingFilesByTask.delete(taskId);
}

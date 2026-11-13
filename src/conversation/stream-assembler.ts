// Stream assembler — 对话管理层的流式文本装配器。
//
// 收拢原 reply-dispatcher 闭包中的 prevModelText/currentModelText 拼接逻辑，
// 升级为有序段模型：
//   - model 段：一次模型调用的完整文本（onStreamText 跨调用边界时锁存）
//   - injected 段：工具注入的非模型文本（如 display-a2ui-card 的卡片 DSL）
//
// 设计要点：
//   - 段以 "\n" 连接，轮间换行符天然保留（锁存不带分隔符的 bug 在结构上消除）。
//   - 权威文本修正：openclaw 在 message_end 发出的最终清洗文本不走
//     onPartialReply，流式累计可能缺尾；deliver(kind=final) 提供 canonical
//     文本，finalize() 时以它替换当前轮（或最后一个 model 段）。
//   - 分段边界切分：工具调用边界、streamingTextId 轮换时 cutSegment()
//     清空已装配内容，后续全量帧只携带边界后新段的文本（禁止新 id 叠加
//     旧 id 段内容下发）。
//   - 低版本链路（app_ver < 11.7.9.330，accumulateModelSegments=false）：
//     模型不同轮产生的回复文本不累加 —— 跨调用边界处直接丢弃上一轮文本
//     （历史装配文本在下一轮发送前清空），全量帧/终帧只携带当前轮文本。
//   - 本类是纯逻辑，不做任何发送；发送由调用方经 outbound-queue 完成。

export interface AssemblerSegment {
  kind: "model" | "injected";
  text: string;
}

export interface StreamAssemblerOptions {
  /**
   * 跨模型调用边界是否累加历史轮文本（默认 true）。
   * true：边界处把上一轮完整文本锁存为 model 段，后续全量帧携带全部历史轮
   * 文本；false（低版本链路）：边界处丢弃上一轮文本，下一轮发送的正文只
   * 携带本轮文本。
   */
  accumulateModelSegments?: boolean;
}

export interface FinalizeResult {
  /** 终帧应携带的全文本（可能为空字符串 —— 异常路径，调用方回退空帧语义）。 */
  fullText: string;
  /** 最后一轮模型调用的解析文本（canonical 优先），供跨任务结果消息使用。 */
  resolvedLastText: string;
  /** 权威文本与流式累计的对比诊断（无权威文本时为 "no-canonical"）。 */
  diagnostic: "match" | "patched-tail" | "canonical-shorter" | "diverged" | "no-canonical";
}

const SEGMENT_SEPARATOR = "\n";

export class StreamAssembler {
  private segments: AssemblerSegment[] = [];
  /** 当前模型调用的流式累计文本（同一调用内递增）。 */
  private currentModelText = "";
  /** deliver(kind=final) 捕获的权威最终文本（最后一次模型调用的 canonical 文本）。 */
  private canonicalFinalText = "";
  /** 跨模型调用边界是否累加历史轮文本（低版本链路置 false，见 StreamAssemblerOptions）。 */
  private readonly accumulateModelSegments: boolean;

  constructor(options: StreamAssemblerOptions = {}) {
    this.accumulateModelSegments = options.accumulateModelSegments ?? true;
  }

  /**
   * onPartialReply 喂入。text 是当前模型调用的累计清洗文本（非增量）。
   * 同一调用内 text 递增；跨调用时 text 刷新（!startsWith），此时把上一个
   * 调用的完整文本锁存为 model 段（不累加模式下直接丢弃 —— 历史装配文本
   * 在下一轮发送前清空，正文只携带本轮文本）。
   */
  onStreamText(text: string): { fullText: string; latched: boolean } {
    let latched = false;
    if (this.currentModelText && !text.startsWith(this.currentModelText)) {
      if (this.accumulateModelSegments) {
        this.segments.push({ kind: "model", text: this.currentModelText });
      }
      latched = true;
    }
    this.currentModelText = text;
    return { fullText: this.getFullText(), latched };
  }

  /**
   * 工具注入非模型文本（如卡片 DSL）。先锁存当前模型文本（保持相对位置），
   * 再把注入内容作为独立段压入。注入后所有全量帧自然携带该段，
   * 客户端 append:false 整体替换不会抹掉注入内容。
   * 不累加模式：注入前的模型文本属于历史轮，与 onStreamText 边界同语义
   * 直接丢弃；注入段本身保留，后续全量帧（含终帧）继续携带。
   */
  injectArtifact(text: string): string {
    if (this.currentModelText && this.accumulateModelSegments) {
      this.segments.push({ kind: "model", text: this.currentModelText });
    }
    this.currentModelText = "";
    this.segments.push({ kind: "injected", text });
    return this.getFullText();
  }

  /**
   * deliver(kind=final) 喂入权威文本。调用方必须已排除 compaction 通知和
   * ⚙️ 系统通知（它们不是答案文本）。
   */
  onFinalText(text: string): void {
    this.canonicalFinalText = text;
  }

  /**
   * onIdle 收口：计算终帧全文本。
   * canonical 非空时替换 currentModelText；current 为空（已锁存/无流式）时
   * 替换最后一个 model 段；完全没有 model 内容（ACP 纯 deliver 路径）时
   * fullText 就是 canonical 本身。
   */
  finalize(): FinalizeResult {
    let resolvedLastText = this.currentModelText;
    let diagnostic: FinalizeResult["diagnostic"] = "no-canonical";
    const canonical = this.canonicalFinalText;

    if (canonical) {
      if (canonical === this.currentModelText) {
        diagnostic = "match";
      } else if (canonical.startsWith(this.currentModelText)) {
        diagnostic = "patched-tail";
      } else if (this.currentModelText.startsWith(canonical)) {
        diagnostic = "canonical-shorter";
      } else {
        diagnostic = "diverged";
      }
      resolvedLastText = canonical;

      if (this.currentModelText) {
        this.currentModelText = canonical;
      } else {
        // current 已锁存或从未流式：替换最后一个 model 段；无 model 段则
        // canonical 自成一段（ACP 纯 deliver 路径）。
        for (let i = this.segments.length - 1; i >= 0; i--) {
          if (this.segments[i].kind === "model") {
            this.segments[i] = { kind: "model", text: canonical };
            return {
              fullText: this.getFullText(),
              resolvedLastText,
              diagnostic,
            };
          }
        }
        this.segments.push({ kind: "model", text: canonical });
      }
    }

    return {
      fullText: this.getFullText(),
      resolvedLastText,
      diagnostic,
    };
  }

  /** 全文本：已锁存段以 "\n" 连接，再接当前模型文本。 */
  getFullText(): string {
    const parts = this.segments.map((s) => s.text);
    if (this.currentModelText) {
      parts.push(this.currentModelText);
    }
    return parts.join(SEGMENT_SEPARATOR);
  }

  /** 是否有任何已装配内容（已锁存段或当前模型文本非空）。 */
  hasContent(): boolean {
    return this.segments.length > 0 || this.currentModelText.length > 0;
  }

  /**
   * 分段边界切分（工具调用边界、streamingTextId 轮换时调用）：
   * 已装配内容（含当前模型文本）全部移出全文本 —— 之后的
   * getFullText()/finalize() 只返回边界之后新段的文本，新 streamingTextId
   * 的文本帧不再叠加携带旧 id 段的内容。
   * canonical 权威文本只在 turn 末尾 deliver(kind=final) 时捕获（晚于任何
   * 切分），不在此处清除。无内容时为 no-op。
   */
  cutSegment(): void {
    this.segments = [];
    this.currentModelText = "";
  }

  /** 新 turn 清空（dispatcher 创建时调用；终帧发出后也应复位）。 */
  reset(): void {
    this.segments = [];
    this.currentModelText = "";
    this.canonicalFinalText = "";
  }
}

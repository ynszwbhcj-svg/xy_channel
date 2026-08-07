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
//   - 本类是纯逻辑，不做任何发送；发送由调用方经 outbound-queue 完成。

export interface AssemblerSegment {
  kind: "model" | "injected";
  text: string;
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

  /**
   * onPartialReply 喂入。text 是当前模型调用的累计清洗文本（非增量）。
   * 同一调用内 text 递增；跨调用时 text 刷新（!startsWith），此时把上一个
   * 调用的完整文本锁存为 model 段。
   */
  onStreamText(text: string): { fullText: string; latched: boolean } {
    let latched = false;
    if (this.currentModelText && !text.startsWith(this.currentModelText)) {
      this.segments.push({ kind: "model", text: this.currentModelText });
      latched = true;
    }
    this.currentModelText = text;
    return { fullText: this.getFullText(), latched };
  }

  /**
   * 工具注入非模型文本（如卡片 DSL）。先锁存当前模型文本（保持相对位置），
   * 再把注入内容作为独立段压入。注入后所有全量帧自然携带该段，
   * 客户端 append:false 整体替换不会抹掉注入内容。
   */
  injectArtifact(text: string): string {
    if (this.currentModelText) {
      this.segments.push({ kind: "model", text: this.currentModelText });
      this.currentModelText = "";
    }
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

  /** 新 turn 清空（dispatcher 创建时调用；终帧发出后也应复位）。 */
  reset(): void {
    this.segments = [];
    this.currentModelText = "";
    this.canonicalFinalText = "";
  }
}

import { redactText, StreamingPiiRedactor } from "./redactor.js";

type JsonObject = Record<string, unknown>;

/**
 * Incremental OpenAI chat-completions SSE transformer.
 * Content deltas are fed to one redactor per choice index so PII split across
 * events is still masked, and each completed event is emitted immediately.
 */
export class OpenAiSseRedactor {
  private readonly decoder = new TextDecoder();
  private pending = "";
  private dataLines: string[] = [];
  private readonly redactors = new Map<number, StreamingPiiRedactor>();
  private template: JsonObject | null = null;
  private sawDone = false;

  push(chunk: Uint8Array | string): string {
    this.pending += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  finish(): string {
    this.pending += this.decoder.decode();
    const drained = this.drain(true);
    if (this.sawDone) return drained;
    return drained + this.emitFlushedContent();
  }

  private redactorFor(index: number): StreamingPiiRedactor {
    let redactor = this.redactors.get(index);
    if (!redactor) {
      redactor = new StreamingPiiRedactor();
      this.redactors.set(index, redactor);
    }
    return redactor;
  }

  private drain(final: boolean): string {
    const parts = this.pending.split(/\r?\n/);
    if (final) {
      this.pending = "";
    } else {
      this.pending = parts.pop() ?? "";
    }
    let out = "";
    for (const line of parts) {
      out += this.consumeLine(line);
    }
    if (final && this.dataLines.length > 0) {
      const data = this.dataLines.join("\n");
      this.dataLines = [];
      out += this.consumeData(data);
    }
    return out;
  }

  private consumeLine(line: string): string {
    if (line.length === 0) {
      if (this.dataLines.length === 0) return "";
      const data = this.dataLines.join("\n");
      this.dataLines = [];
      return this.consumeData(data);
    }
    if (line.startsWith(":")) return "";
    if (line.startsWith("data:")) {
      this.dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    return "";
  }

  private consumeData(data: string): string {
    if (data === "[DONE]") {
      this.sawDone = true;
      return this.emitFlushedContent() + "data: [DONE]\n\n";
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return `data: ${data}\n\n`;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return `data: ${data}\n\n`;
    }
    const record = parsed as JsonObject;
    this.template = record;
    if (!Array.isArray(record.choices)) {
      return frame(record);
    }

    let prefix = "";
    const nextChoices: JsonObject[] = [];
    for (const choice of record.choices) {
      if (!choice || typeof choice !== "object" || Array.isArray(choice)) continue;
      const current = choice as JsonObject;
      const index = typeof current.index === "number" ? current.index : 0;
      const redactor = this.redactorFor(index);
      const delta =
        current.delta && typeof current.delta === "object" && !Array.isArray(current.delta)
          ? { ...(current.delta as JsonObject) }
          : {};
      if (typeof delta.content === "string") {
        const emitted = redactor.push(delta.content);
        if (emitted.length > 0) delta.content = emitted;
        else delete delta.content;
      }
      const finishing = current.finish_reason != null;
      if (finishing) {
        const tail = redactor.flush();
        if (tail.length > 0) prefix += frame(this.eventWithContent(index, tail));
      }
      if (Object.keys(delta).length === 0 && !finishing) continue;
      nextChoices.push({ ...current, index, delta });
    }

    let out = prefix;
    if (nextChoices.length > 0) out += frame({ ...record, choices: nextChoices });
    return out;
  }

  private emitFlushedContent(): string {
    let out = "";
    for (const [index, redactor] of this.redactors) {
      const tail = redactor.flush();
      if (tail.length > 0) out += frame(this.eventWithContent(index, tail));
    }
    return out;
  }

  private eventWithContent(index: number, content: string): JsonObject {
    const base = this.template ?? {
      id: "chatcmpl-guardrail",
      object: "chat.completion.chunk",
    };
    return {
      ...base,
      choices: [{ index, delta: { content }, finish_reason: null }],
    };
  }
}

function frame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

export function redactCompletionPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const clone = structuredClone(payload) as JsonObject;
  if (!Array.isArray(clone.choices)) return clone;
  for (const choice of clone.choices) {
    if (!choice || typeof choice !== "object") continue;
    const message = (choice as { message?: { content?: unknown } }).message;
    if (!message) continue;
    if (typeof message.content === "string") {
      message.content = redactText(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          (part as { text: string }).text = redactText((part as { text: string }).text);
        }
      }
    }
  }
  return clone;
}

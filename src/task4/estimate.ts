export type TokenEstimate = { ok: true; tokens: number } | { ok: false };

function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (typeof part === "string") {
      total += part.length;
      continue;
    }
    if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
      total += (part as { text: string }).text.length;
    }
  }
  return total;
}

function completionBudget(body: Record<string, unknown>): number | null {
  const raw = body.max_completion_tokens ?? body.max_tokens;
  if (raw === undefined) return 0;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return null;
  return raw;
}

/**
 * Prompt tokens are ceil(characters / 4). Completion tokens are reserved up
 * front from max_tokens or max_completion_tokens so in-flight calls cannot
 * overshoot the window. The router later replaces this estimate when the
 * provider returns usage.total_tokens.
 */
export function estimateRequestTokens(body: unknown): TokenEstimate {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false };
  const record = body as Record<string, unknown>;
  const completion = completionBudget(record);
  if (completion === null) return { ok: false };

  let chars = 0;
  let sawPrompt = false;
  if (typeof record.prompt === "string") {
    chars += record.prompt.length;
    sawPrompt = true;
  }
  if (Array.isArray(record.messages)) {
    if (record.messages.length === 0 && !sawPrompt) return { ok: false };
    for (const message of record.messages) {
      if (!message || typeof message !== "object") return { ok: false };
      chars += contentChars((message as { content?: unknown }).content);
    }
    sawPrompt = true;
  }
  if (!sawPrompt) return { ok: false };

  const promptTokens = Math.ceil(chars / 4);
  return { ok: true, tokens: Math.max(1, promptTokens + completion) };
}

export function readReportedUsage(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const total = (usage as { total_tokens?: unknown }).total_tokens;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total <= 0 || total > 10_000_000) {
    return null;
  }
  return total;
}

/** Replacement token required by the assessment. */
export const REDACTED = "[REDACTED]";

/**
 * Longest sensitive token we are willing to hold across chunks.
 * An email is at most 64 (local) + 1 + 253 (domain). Card runs are much shorter.
 * Anything still buffered past this is emitted so memory stays bounded.
 */
export const MAX_BUFFER_CHARS = 512;

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g;

type Span = { start: number; end: number };

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) return false;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export function isSensitiveCard(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  if (!/^[3-6]/.test(digits)) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  return luhnValid(digits);
}

function collect(pattern: RegExp, text: string): Span[] {
  pattern.lastIndex = 0;
  const spans: Span[] = [];
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

function collectCards(text: string): Span[] {
  CARD_RE.lastIndex = 0;
  const spans: Span[] = [];
  for (const match of text.matchAll(CARD_RE)) {
    if (match.index === undefined) continue;
    const digits = match[0].replace(/\D/g, "");
    if (!isSensitiveCard(digits)) continue;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

function applySpans(text: string, spans: Span[]): string {
  const ordered = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let cursor = 0;
  for (const span of ordered) {
    if (span.start < cursor) continue;
    out += text.slice(cursor, span.start);
    out += REDACTED;
    cursor = span.end;
  }
  out += text.slice(cursor);
  return out;
}

/** Redact complete emails, SSNs, and Luhn-valid card numbers in a closed string. */
export function redactComplete(text: string): string {
  const spans = [...collect(EMAIL_RE, text), ...collect(SSN_RE, text), ...collectCards(text)];
  if (spans.length === 0) return text;
  return applySpans(text, spans);
}

/**
 * A trailing email candidate is a local-part, or local@domain, that could still
 * grow when the next chunk arrives. Words longer than 64 characters without an
 * @ cannot become a valid local-part, so they are not held.
 */
function trailingEmailLength(text: string): number {
  const match = text.match(/[A-Za-z0-9._%+-]+(?:@[A-Za-z0-9.-]*)?$/);
  if (!match) return 0;
  const token = match[0];
  if (token.length > MAX_BUFFER_CHARS) return 0;
  const at = token.indexOf("@");
  if (at === -1) return token.length <= 64 ? token.length : 0;
  const local = token.slice(0, at);
  const domain = token.slice(at + 1);
  if (local.length < 1 || local.length > 64) return 0;
  if (domain.length > 253) return 0;
  if (token.slice(at + 1).includes("@")) return 0;
  return token.length;
}

/**
 * Hold a trailing card/SSN run, including one unfinished space or dash, while
 * it can still grow into a 13–19 digit card or a 3-2-4 SSN. A longer digit run
 * cannot be a card, so it is released instead of keeping its tail.
 */
function trailingAccountLength(text: string): number {
  const match = text.match(/\d(?:[ -]?\d)*[ -]?$/);
  if (!match) return 0;
  const token = match[0];
  if (/\s{2}|--/.test(token)) return 0;
  const digits = token.replace(/\D/g, "");
  if (digits.length < 1 || digits.length > 19) return 0;
  return token.length;
}

export function openSuffixLength(text: string): number {
  // A comma or period after a card/SSN closes that run. Do not keep a shorter
  // email-like tail such as the last group of a spaced card ("1111.").
  if (/[.,;:!?)]$/.test(text)) {
    if (trailingAccountLength(text.slice(0, -1)) > 0) return 0;
  }
  return Math.max(trailingEmailLength(text), trailingAccountLength(text));
}

/**
 * Streaming redactor. Each push emits text that can no longer grow into PII
 * and holds only the trailing candidate. Call flush when the stream ends.
 */
export class StreamingPiiRedactor {
  private buffer = "";

  get bufferedLength(): number {
    return this.buffer.length;
  }

  push(chunk: string): string {
    if (chunk.length === 0) return "";
    this.buffer += chunk;
    const hold = Math.min(openSuffixLength(this.buffer), MAX_BUFFER_CHARS);
    const emitLength = this.buffer.length - hold;
    if (emitLength <= 0) return "";
    const slice = this.buffer.slice(0, emitLength);
    this.buffer = this.buffer.slice(emitLength);
    return redactComplete(slice);
  }

  flush(): string {
    if (this.buffer.length === 0) return "";
    const out = redactComplete(this.buffer);
    this.buffer = "";
    return out;
  }
}

export function redactText(text: string): string {
  const redactor = new StreamingPiiRedactor();
  return redactor.push(text) + redactor.flush();
}

import { describe, expect, it } from "vitest";
import { CANNED_COMPLETION, createMockLlmServer } from "../src/task3/mock-provider.js";
import { MAX_BUFFER_CHARS, redactText, StreamingPiiRedactor } from "../src/task3/redactor.js";
import { createGuardrailServer } from "../src/task3/gateway.js";
import { OpenAiSseRedactor } from "../src/task3/sse.js";
import { close, listen } from "./helpers.js";

const SAMPLE =
  "Hello Avery. Email billing@example.com, ssn 123-45-6789, card 4111 1111 1111 1111, amex 378282246310005, order 12345, on 2026-10-29.";

function streamed(text: string, size: number): string {
  const redactor = new StreamingPiiRedactor();
  let out = "";
  for (let index = 0; index < text.length; index += size) {
    out += redactor.push(text.slice(index, index + size));
    expect(redactor.bufferedLength).toBeLessThanOrEqual(MAX_BUFFER_CHARS);
  }
  out += redactor.flush();
  expect(redactor.bufferedLength).toBe(0);
  return out;
}

function contentOf(sse: string): string {
  let text = "";
  for (const block of sse.split("\n\n")) {
    const line = block.split("\n").find((entry) => entry.startsWith("data:"));
    if (!line) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
    text += parsed.choices?.[0]?.delta?.content ?? "";
  }
  return text;
}

describe("task 3 streaming redactor", () => {
  it("redacts complete emails, SSNs, and Luhn-valid cards without eating ordinary numbers", () => {
    const redacted = redactText(SAMPLE);
    expect(redacted).toBe(
      "Hello Avery. Email [REDACTED], ssn [REDACTED], card [REDACTED], amex [REDACTED], order 12345, on 2026-10-29.",
    );
    expect(redactText("not a card 4111111111111112.")).toContain("4111111111111112");
    expect(redactText("reach me at user+tag@example.co.uk.")).toBe("reach me at [REDACTED].");
  });

  it("matches the full-string result for every chunk size, including one character", () => {
    const expected = redactText(SAMPLE);
    for (const size of [1, 2, 3, 5, 7, 16, 64]) {
      expect(streamed(SAMPLE, size)).toBe(expected);
    }
  });

  it("holds a split secret until it is closed, and emits safe text immediately", () => {
    const redactor = new StreamingPiiRedactor();
    expect(redactor.push("Hello ")).toBe("Hello ");
    expect(redactor.push("ada@")).toBe("");
    expect(redactor.push("quilr.ai ")).toBe("[REDACTED] ");
    expect(redactor.push("ssn 123-45-")).toBe("ssn ");
    expect(redactor.push("6789.")).toBe("[REDACTED].");
    expect(redactor.flush()).toBe("");

    const card = new StreamingPiiRedactor();
    expect(card.push("card 4111 1111 ")).toBe("card ");
    expect(card.push("1111 1111 thanks")).toBe("[REDACTED] ");
    expect(card.flush()).toBe("thanks");
  });

  it("does not hold an unbounded buffer", () => {
    const redactor = new StreamingPiiRedactor();
    const emitted = redactor.push(`${"a".repeat(20_000)} `);
    expect(emitted.length).toBeGreaterThan(19_000);
    expect(redactor.bufferedLength).toBe(0);
    expect(redactor.push("a".repeat(64))).toBe("");
    expect(redactor.bufferedLength).toBe(64);
  });
});

describe("task 3 SSE gateway", () => {
  it("redacts PII that is split across provider events", () => {
    const sse = new OpenAiSseRedactor();
    const frame = (content: string) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
    let out = "";
    const first = frame("Email ada@");
    out += sse.push(first.slice(0, 8));
    out += sse.push(first.slice(8));
    out += sse.push(frame("quilr.ai and 4111"));
    out += sse.push(frame(" 1111 1111 1111."));
    out += sse.push("data: [DONE]\n\n");
    out += sse.finish();
    const text = contentOf(out);
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("ada@quilr.ai");
    expect(text).not.toContain("4111 1111 1111 1111");
    expect(text).toContain("Email ");
  });

  it("streams the first safe token before the rest of the upstream body is available", async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    const fetchImpl: typeof fetch = async () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hello " }, finish_reason: null }] })}\n\n`,
            ),
          );
          await hold;
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "billing@example.com " }, finish_reason: null }] })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };

    const server = createGuardrailServer({ upstreamUrl: "http://upstream.test/v1/chat/completions", fetchImpl });
    const port = await listen(server);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing body");
      const decoder = new TextDecoder();
      let seen = "";
      while (!seen.includes("Hello ")) {
        const { done, value } = await reader.read();
        if (done) break;
        seen += decoder.decode(value, { stream: true });
      }
      expect(seen).toContain("Hello ");
      expect(seen).not.toContain("billing@example.com");
      release();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        seen += decoder.decode(value, { stream: true });
      }
      expect(seen).toContain("[REDACTED]");
      expect(seen).not.toContain("billing@example.com");
    } finally {
      await close(server);
    }
  });

  it("redacts the canned provider stream and hides upstream error bodies", async () => {
    const provider = createMockLlmServer();
    const providerPort = await listen(provider);
    const gateway = createGuardrailServer({
      upstreamUrl: `http://127.0.0.1:${providerPort}/v1/chat/completions`,
    });
    const port = await listen(gateway);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "Summarize the account." }] }),
      });
      const text = await response.text();
      const content = contentOf(text);
      expect(content.startsWith("Hello from Quilr.")).toBe(true);
      expect(content).not.toContain("billing@example.com");
      expect(content).not.toContain("123-45-6789");
      expect(content).not.toContain("4111 1111 1111 1111");
      expect(content.match(/\[REDACTED\]/g)?.length).toBe(3);
      expect(text).toContain("data: [DONE]");

      const quiet = createGuardrailServer({
        upstreamUrl: "http://upstream.test/v1/chat/completions",
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: "Error: boom\n    at secret (/var/secret/stack.js:1:1)" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      });
      const quietPort = await listen(quiet);
      try {
        const failed = await fetch(`http://127.0.0.1:${quietPort}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stream: false, messages: [{ role: "user", content: "hi" }] }),
        });
        const body = await failed.text();
        expect(failed.status).toBe(502);
        expect(body).not.toContain("secret");
        expect(body).not.toContain("boom");
        expect(body).toContain("gateway_error");
      } finally {
        await close(quiet);
      }
    } finally {
      await close(gateway);
      await close(provider);
    }
  });

  it("redacts a non-streaming completion payload", async () => {
    const server = createGuardrailServer({
      upstreamUrl: "http://upstream.test/v1/chat/completions",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: CANNED_COMPLETION } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const port = await listen(server);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stream: false, messages: [{ role: "user", content: "hi" }] }),
      });
      const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      expect(body.choices[0]?.message.content).not.toContain("billing@example.com");
      expect(body.choices[0]?.message.content).toContain("[REDACTED]");
    } finally {
      await close(server);
    }
  });
});

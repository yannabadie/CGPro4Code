import { describe, it, expect } from "vitest";
import { SseParser } from "../src/core/stream.js";

describe("SseParser", () => {
  it("parses simple {v: text} append deltas", () => {
    const p = new SseParser();
    const e1 = p.feed('data: {"v":"hello "}\n\n');
    const e2 = p.feed('data: {"v":"world"}\n\n');
    const text1 = e1.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    const text2 = e2.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    expect(text1).toBe("hello ");
    expect(text2).toBe("world");
    expect(p.cumulativeText()).toBe("hello world");
  });

  it("parses {p, o, v} json patches that target message parts", () => {
    const p = new SseParser();
    const events = p.feed(
      'data: {"p":"/message/content/parts/0","o":"append","v":"Bonjour"}\n\n' +
        'data: {"p":"/message/content/parts/0","o":"append","v":" monde"}\n\n',
    );
    const text = events
      .filter((e) => e.type === "delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(text).toBe("Bonjour monde");
  });

  it("handles cumulative {message.content.parts} replacement", () => {
    const p = new SseParser();
    const e1 = p.feed(
      'data: {"message":{"content":{"parts":["Hello"]}}}\n\n',
    );
    const e2 = p.feed(
      'data: {"message":{"content":{"parts":["Hello world"]}}}\n\n',
    );
    const t1 = e1.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    const t2 = e2.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    expect(t1).toBe("Hello");
    expect(t2).toBe(" world");
    expect(p.cumulativeText()).toBe("Hello world");
  });

  it("emits a single 'started' before the first delta", () => {
    const p = new SseParser();
    const events = p.feed(
      'data: {"v":"a"}\n\ndata: {"v":"b"}\n\n',
    );
    const started = events.filter((e) => e.type === "started");
    expect(started.length).toBe(1);
  });

  it("captures conversation_id from the stream", () => {
    const p = new SseParser();
    const events = p.feed(
      'data: {"conversation_id":"abc","v":"hi"}\n\n',
    );
    const started = events.find((e) => e.type === "started") as { conversationId?: string } | undefined;
    expect(started?.conversationId).toBe("abc");
  });

  it("ignores [DONE] sentinel and malformed JSON", () => {
    const p = new SseParser();
    const events = p.feed(
      'data: {"v":"ok"}\n\ndata: not json\n\ndata: [DONE]\n\n',
    );
    const text = events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe("ok");
  });

  it("handles fragmented chunks across feed() calls", () => {
    const p = new SseParser();
    p.feed('data: {"v":"hel');
    p.feed('lo"}\n\ndata: {"v":" world"');
    const events = p.feed('}\n\n');
    const text = events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe(" world");
    expect(p.cumulativeText()).toBe("hello world");
  });
});

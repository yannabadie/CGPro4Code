import type { Page } from "playwright";

export type StreamEvent =
  | { type: "started"; conversationId?: string; model?: string; web?: boolean }
  | { type: "delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; name: string; meta?: unknown }
  | { type: "sources"; items: Array<{ title?: string; url?: string }> }
  | { type: "error"; message: string }
  | { type: "done"; finalText?: string };

interface QueueEntry {
  resolve: (e: StreamEvent | null) => void;
  reject: (e: Error) => void;
}

/**
 * AsyncIterable<StreamEvent> backed by an in-memory queue. The browser
 * bindings push events; the consumer (CLI) pulls.
 */
export class StreamEmitter implements AsyncIterable<StreamEvent> {
  private buffer: StreamEvent[] = [];
  private waiters: QueueEntry[] = [];
  private finished = false;
  private errored: Error | null = null;

  push(event: StreamEvent): void {
    if (this.finished) return;
    if (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w.resolve(event);
    } else {
      this.buffer.push(event);
    }
    if (event.type === "done" || event.type === "error") {
      this.finished = true;
      while (this.waiters.length > 0) {
        const w = this.waiters.shift()!;
        w.resolve(null);
      }
    }
  }

  fail(err: Error): void {
    if (this.finished) return;
    this.errored = err;
    this.finished = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w.reject(err);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return {
      next: async (): Promise<IteratorResult<StreamEvent>> => {
        if (this.errored) throw this.errored;
        if (this.buffer.length > 0) {
          const value = this.buffer.shift()!;
          return { value, done: false };
        }
        if (this.finished) return { value: undefined, done: true };
        return new Promise<IteratorResult<StreamEvent>>((resolve, reject) => {
          this.waiters.push({
            resolve: (e) => {
              if (e === null) resolve({ value: undefined, done: true });
              else resolve({ value: e, done: false });
            },
            reject,
          });
        });
      },
    };
  }
}

/**
 * Installs a window.fetch wrapper inside the page that mirrors any
 * /backend-api/conversation SSE response into a Node-side binding.
 *
 * The page issues the real request (so it owns the proof tokens), and
 * we shadow-stream the response chunks.
 */
export async function installSseInterceptor(page: Page, emitter: StreamEmitter): Promise<void> {
  // SSE chunk parser state
  const parser = new SseParser();

  await page.exposeBinding("__cgproChunk", (_src, raw: string) => {
    for (const event of parser.feed(raw)) {
      emitter.push(event);
    }
  });

  await page.exposeBinding("__cgproDone", (_src, payload?: { reason?: string }) => {
    emitter.push({ type: "done", finalText: parser.cumulativeText() });
    parser.reset();
    if (payload?.reason === "error") {
      // No-op: error already emitted by interceptor.
    }
  });

  await page.addInitScript(() => {
    // Run inside every page (main + workers).
    const w = window as unknown as Window & {
      __cgproInstalled?: boolean;
      __cgproChunk?: (raw: string) => void;
      __cgproDone?: (payload?: { reason?: string }) => void;
    };
    if (w.__cgproInstalled) return;
    w.__cgproInstalled = true;

    const isTargetUrl = (url: string): boolean =>
      url.includes("/backend-api/conversation") || url.includes("/backend-api/f/conversation");

    const originalFetch = w.fetch.bind(w);
    w.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
      let url = "";
      const first = args[0];
      if (typeof first === "string") url = first;
      else if (first instanceof URL) url = first.toString();
      else if (first instanceof Request) url = first.url;

      const response = await originalFetch(...args);

      if (!isTargetUrl(url)) return response;

      const init = args[1];
      const method =
        (init && (init as RequestInit).method) ||
        (first instanceof Request ? first.method : "GET");
      if (method.toUpperCase() !== "POST") return response;

      try {
        const cloned = response.clone();
        const reader = cloned.body?.getReader();
        if (!reader) return response;
        const decoder = new TextDecoder();
        (async () => {
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value) {
                const text = decoder.decode(value, { stream: true });
                if (text) w.__cgproChunk?.(text);
              }
            }
            const tail = decoder.decode();
            if (tail) w.__cgproChunk?.(tail);
            w.__cgproDone?.();
          } catch (err) {
            w.__cgproDone?.({ reason: "error" });
          }
        })();
      } catch {
        // Ignore — interception failed, page works normally.
      }
      return response;
    };
  });
}

/**
 * Parses incremental SSE chunks from /backend-api/conversation. Tolerant
 * to schema drift: extracts text/parts wherever they appear, and emits
 * cumulative-aware deltas.
 */
export class SseParser {
  private leftover = "";
  private latestText = "";
  private startedSent = false;
  private capturedConvId?: string;

  feed(chunk: string): StreamEvent[] {
    const events: StreamEvent[] = [];
    const buf = this.leftover + chunk;
    const parts = buf.split("\n\n");
    this.leftover = parts.pop() ?? "";

    for (const block of parts) {
      const dataLines = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      for (const line of dataLines) {
        if (!line) continue;
        if (line === "[DONE]") {
          continue;
        }
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch {
          continue;
        }
        const eventList = this.extractEvents(json);
        for (const ev of eventList) events.push(ev);
      }
    }

    return events;
  }

  private extractEvents(payload: unknown): StreamEvent[] {
    const out: StreamEvent[] = [];

    if (!payload || typeof payload !== "object") return out;
    const p = payload as Record<string, unknown>;

    // Capture conversation id if present.
    if (typeof p["conversation_id"] === "string" && !this.capturedConvId) {
      this.capturedConvId = p["conversation_id"] as string;
    }

    if (!this.startedSent) {
      this.startedSent = true;
      out.push({ type: "started", conversationId: this.capturedConvId });
    }

    // ChatGPT modern stream usually sends one of:
    //   {v: "delta text"} for incremental deltas
    //   {message: {content: {parts: [...]}}} for cumulative replacements
    //   {p: "patch", o: "append/replace", v: "..."} for granular patches
    //   {type: "delta", v: "..."} for newer schemas
    //
    // We try in order and concatenate all encountered text into latestText.

    // Simple {v: "text"} delta with append
    if (typeof p["v"] === "string" && p["o"] === undefined && p["p"] === undefined) {
      const text = p["v"] as string;
      if (text) {
        this.latestText += text;
        out.push({ type: "delta", text });
      }
    }

    // {p: "/message/content/parts/0", o: "append", v: "..."}  — JSON patch
    if (
      typeof p["p"] === "string" &&
      typeof p["v"] === "string" &&
      typeof p["o"] === "string"
    ) {
      const path = p["p"] as string;
      const op = p["o"] as string;
      const text = p["v"] as string;
      if (path.includes("/message/content/parts") && op === "append" && text) {
        this.latestText += text;
        out.push({ type: "delta", text });
      }
    } else if (typeof p["v"] === "string" && typeof p["o"] === "string") {
      // Simple {v: "text", o: "append"} or {v: "text", o: "replace"} (no path)
      const text = p["v"] as string;
      const op = p["o"] as string;
      if (op === "append") {
        this.latestText += text;
        out.push({ type: "delta", text });
      } else if (op === "replace") {
        const oldLen = this.latestText.length;
        const newDelta = text.startsWith(this.latestText) ? text.slice(oldLen) : text;
        this.latestText = text;
        if (newDelta) out.push({ type: "delta", text: newDelta });
      }
    }

    // {message: {content: {parts: [...]}}} (cumulative)
    const msg = p["message"];
    if (msg && typeof msg === "object") {
      const mm = msg as Record<string, unknown>;
      const content = mm["content"];
      if (content && typeof content === "object") {
        const cc = content as Record<string, unknown>;
        const parts = cc["parts"];
        if (Array.isArray(parts) && parts.length > 0) {
          const joined = parts.filter((x) => typeof x === "string").join("");
          if (joined && joined !== this.latestText) {
            const delta = joined.startsWith(this.latestText)
              ? joined.slice(this.latestText.length)
              : joined;
            this.latestText = joined;
            if (delta) out.push({ type: "delta", text: delta });
          }
        }
      }
      const author = mm["author"] as { role?: string } | undefined;
      if (author?.role === "tool") {
        out.push({ type: "tool", name: (mm["recipient"] as string) ?? "tool", meta: mm });
      }
    }

    // {type: "title_generation", title: "..."} → ignore for now
    // {type: "message_completed"} → ignore

    return out;
  }

  cumulativeText(): string {
    return this.latestText;
  }

  reset(): void {
    this.leftover = "";
    this.latestText = "";
    this.startedSent = false;
    this.capturedConvId = undefined;
  }
}

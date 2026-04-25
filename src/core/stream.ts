import type { BrowserContext, Page } from "playwright";

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

  isFinished(): boolean {
    return this.finished;
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
 * Per-context interceptor state. The binding is registered ONCE per
 * BrowserContext (not per turn) — per-turn we swap which emitter+parser
 * the binding routes to.
 */
class InterceptorState {
  parser: SseParser = new SseParser();
  emitter: StreamEmitter | null = null;
}

const STATE = new WeakMap<BrowserContext, InterceptorState>();

/**
 * One-time setup: registers `__cgproChunk` / `__cgproDone` bindings on the
 * context and adds the fetch-wrapping init script. Idempotent: subsequent
 * calls are no-ops.
 */
export async function ensureInterceptorInstalled(context: BrowserContext): Promise<void> {
  if (STATE.has(context)) return;
  const state = new InterceptorState();
  STATE.set(context, state);

  await context.exposeBinding("__cgproChunk", (_src, raw: string) => {
    const events = state.parser.feed(raw);
    if (state.emitter) {
      for (const ev of events) state.emitter.push(ev);
    }
  });

  await context.exposeBinding(
    "__cgproDone",
    (_src, payload?: { reason?: string }) => {
      if (state.emitter) {
        if (payload?.reason === "error") {
          state.emitter.push({
            type: "error",
            message: "fetch interceptor caught a stream error",
          });
        } else {
          state.emitter.push({
            type: "done",
            finalText: state.parser.cumulativeText(),
          });
        }
      }
    },
  );

  await context.addInitScript(() => {
    const w = window as unknown as Window & {
      __cgproInstalled?: boolean;
      __cgproChunk?: (raw: string) => void;
      __cgproDone?: (payload?: { reason?: string }) => void;
    };
    if (w.__cgproInstalled) return;
    w.__cgproInstalled = true;

    const isTargetUrl = (url: string): boolean =>
      /\/backend-api\/(f\/)?conversation(\b|\/)/.test(url) ||
      /\/backend-api\/conversations\/.+\/turns/.test(url);

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
          } catch {
            w.__cgproDone?.({ reason: "error" });
          }
        })();
      } catch {
        // Interception failed; the page still works normally.
      }
      return response;
    };
  });
}

/**
 * Switches the active emitter for the given context's interceptor.
 * Resets the SSE parser so the next turn starts from a clean slate.
 *
 * Returns the previous emitter (caller may want to flush or fail it).
 */
export function setActiveEmitter(
  context: BrowserContext,
  emitter: StreamEmitter | null,
): StreamEmitter | null {
  const state = STATE.get(context);
  if (!state) return null;
  const prev = state.emitter;
  state.emitter = emitter;
  state.parser.reset();
  return prev;
}

/**
 * Convenience: install (if needed) AND set this emitter as active.
 *
 * The page parameter exists for symmetry with old callers but the binding
 * actually lives at the context level so it survives navigation and
 * additional pages.
 */
export async function installSseInterceptor(
  page: Page,
  emitter: StreamEmitter,
): Promise<void> {
  const ctx = page.context();
  await ensureInterceptorInstalled(ctx);
  setActiveEmitter(ctx, emitter);
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

    if (typeof p["conversation_id"] === "string" && !this.capturedConvId) {
      this.capturedConvId = p["conversation_id"] as string;
    }

    if (!this.startedSent) {
      this.startedSent = true;
      out.push({ type: "started", conversationId: this.capturedConvId });
    }

    // {p, o, v} JSON-patch (specific paths) — checked first so it doesn't
    // overlap with the simple {v, o} branch.
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
      // {v, o} append/replace (no path)
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
    } else if (typeof p["v"] === "string" && p["o"] === undefined && p["p"] === undefined) {
      // {v: text} simple append
      const text = p["v"] as string;
      if (text) {
        this.latestText += text;
        out.push({ type: "delta", text });
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

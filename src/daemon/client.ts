/**
 * HTTP+SSE client for the cgpro daemon. Mirrors the `AskRunner` shape
 * exported by `core/orchestrator.ts` so callers (the `ask` and `chat`
 * commands) can swap between cold-start and daemon mode without
 * branching their stream-handling logic.
 */

import { request } from "node:http";
import { StreamEmitter, type StreamEvent } from "../core/stream.js";
import {
  pidIsAlive,
  readDaemonInfo,
  type AskRequest,
  type AskSummary,
  type DaemonInfo,
  type StatusResponse,
} from "./protocol.js";
import type { AskOptions, AskResult, AskRunner } from "../core/orchestrator.js";

/**
 * Returns the daemon connection if a live daemon is running on this
 * box, else null. Cleans up stale daemon.json files (orphan pid +
 * unreachable port) so subsequent calls don't keep retrying them.
 */
export async function getLiveDaemon(): Promise<DaemonInfo | null> {
  const info = readDaemonInfo();
  if (!info) return null;
  if (!pidIsAlive(info.pid)) return null;
  const ok = await healthCheck(info, 800);
  if (!ok) return null;
  return info;
}

async function healthCheck(info: DaemonInfo, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: info.port,
        path: "/healthz",
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        // Drain so the socket frees.
        res.resume();
        resolve((res.statusCode ?? 0) === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export async function getDaemonStatus(info: DaemonInfo): Promise<StatusResponse | null> {
  return await jsonRequest<StatusResponse>(info, "GET", "/status", null);
}

export async function shutdownDaemon(info: DaemonInfo): Promise<boolean> {
  const r = await jsonRequest<{ ok: boolean }>(info, "POST", "/shutdown", {});
  return r?.ok === true;
}

function jsonRequest<T>(
  info: DaemonInfo,
  method: string,
  path: string,
  body: unknown,
): Promise<T | null> {
  return new Promise((resolve) => {
    const payload = body === null ? undefined : JSON.stringify(body);
    const req = request(
      {
        hostname: "127.0.0.1",
        port: info.port,
        path,
        method,
        timeout: 5_000,
        headers: {
          Authorization: `Bearer ${info.token}`,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if ((res.statusCode ?? 0) >= 400) return resolve(null);
          try {
            resolve(JSON.parse(buf) as T);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Talks to the daemon's POST /ask endpoint, parses the SSE response,
 * and exposes the same `AskRunner` shape as `runAsk` so callers can
 * stay agnostic.
 */
export function askViaDaemon(info: DaemonInfo, opts: AskOptions): AskRunner {
  const emitter = new StreamEmitter();
  const collected: StreamEvent[] = [];
  let summary: AskSummary | null = null;
  let httpReq: ReturnType<typeof request> | null = null;

  const askBody: AskRequest = {
    prompt: opts.prompt,
    model: opts.model,
    web: opts.web,
    images: opts.images,
    conversationId: opts.conversationId,
    timeoutSec: opts.timeoutSec,
  };
  const payload = JSON.stringify(askBody);

  const result: Promise<AskResult> = new Promise((resolve, reject) => {
    httpReq = request(
      {
        hostname: "127.0.0.1",
        port: info.port,
        path: "/ask",
        method: "POST",
        // Generous read window: GPT-5.5 Pro can think for many minutes.
        timeout: Math.max(60_000, (opts.timeoutSec + 30) * 1_000),
        headers: {
          Authorization: `Bearer ${info.token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Accept: "text/event-stream",
        },
      },
      (res) => {
        if ((res.statusCode ?? 0) === 409) {
          emitter.push({ type: "error", message: "daemon is busy with another turn" });
          res.resume();
          resolve({ conversationId: null, finalText: "", events: collected });
          return;
        }
        if ((res.statusCode ?? 0) >= 400) {
          let buf = "";
          res.setEncoding("utf-8");
          res.on("data", (c) => (buf += c));
          res.on("end", () => {
            const msg = buf.length > 0 ? buf : `daemon returned ${res.statusCode}`;
            emitter.push({ type: "error", message: msg });
            resolve({ conversationId: null, finalText: "", events: collected });
          });
          return;
        }
        consumeSseStream(res, (event, data) => {
          if (event === "summary") {
            summary = data as AskSummary;
            return;
          }
          // The server emits the same event names as our StreamEvent union.
          // Validate the type before pushing.
          const ev = data as StreamEvent;
          if (ev && typeof ev.type === "string") {
            emitter.push(ev);
          }
        }).then(() => {
          const finalText = summary?.finalText ?? extractFinalText(collected);
          const conversationId = summary?.conversationId ?? null;
          if (!emitter.isFinished()) {
            emitter.push({ type: "done", finalText });
          }
          resolve({ conversationId, finalText, events: collected });
        }).catch((err) => {
          emitter.push({ type: "error", message: (err as Error).message });
          reject(err);
        });
      },
    );
    httpReq.on("error", (err) => {
      emitter.push({ type: "error", message: (err as Error).message });
      reject(err);
    });
    httpReq.on("timeout", () => {
      httpReq?.destroy();
      const err = new Error("daemon request timed out");
      emitter.push({ type: "error", message: err.message });
      reject(err);
    });
    httpReq.write(payload);
    httpReq.end();
  });

  return {
    events: teeEvents(emitter, collected),
    result,
    async cancel(): Promise<void> {
      try {
        httpReq?.destroy();
      } catch {
        /* swallow */
      }
    },
  };
}

async function consumeSseStream(
  res: NodeJS.ReadableStream,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = "";
    res.setEncoding("utf-8");
    res.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const parsed = parseSseBlock(block);
        if (parsed) onEvent(parsed.event, parsed.data);
      }
    });
    res.on("end", () => resolve());
    res.on("error", (err: Error) => reject(err));
  });
}

function parseSseBlock(block: string): { event: string; data: unknown } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}

function extractFinalText(events: StreamEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "done" && ev.finalText) return ev.finalText;
  }
  let buf = "";
  for (const ev of events) {
    if (ev.type === "delta") buf += ev.text;
  }
  return buf;
}

async function* teeEvents(
  emitter: StreamEmitter,
  collected: StreamEvent[],
): AsyncIterable<StreamEvent> {
  for await (const ev of emitter) {
    collected.push(ev);
    yield ev;
  }
}

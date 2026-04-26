/**
 * Long-lived `cgpro` daemon — keeps a Chromium open + warm so that
 * subsequent `cgpro ask` calls don't pay the ~3-5s cold-start tax.
 *
 * Process lifecycle
 * -----------------
 *   1. `cgpro daemon start` spawns this module detached, with
 *      stdio redirected to ~/.cgpro/logs/daemon.log
 *   2. We open a browser session, verify the cookie jar is authenticated,
 *      then bind an HTTP server on 127.0.0.1:<random-port>.
 *   3. On `listen`, we write daemon.json (pid, port, token) so clients
 *      can find us. We accept Bearer-token auth on every protected route.
 *   4. POST /ask → text/event-stream of {delta,thinking,tool,done,error}.
 *      One ask in flight at a time; concurrent calls get 409 Busy.
 *   5. POST /shutdown closes the browser, deletes daemon.json, exits.
 *
 * Failure model
 * -------------
 *   - browser context dies → we exit with code 1 (the wrapper writes a
 *     log line; user re-runs `cgpro daemon start`). We don't try to
 *     resurrect the browser silently because cookie/auth state may
 *     have changed and a clean restart is the honest fix.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { appendFileSync, openSync, writeSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openSession, type Session } from "../browser/session.js";
import { goHome, isLoggedIn } from "../browser/chatgpt.js";
import { runAskOnSession, type AskOptions } from "../core/orchestrator.js";
import { NotLoggedInError } from "../errors.js";
import {
  clearDaemonInfo,
  DAEMON_LOG,
  writeDaemonInfo,
  type DaemonInfo,
  type AskRequest,
  type StatusResponse,
} from "./protocol.js";

const log = makeLogger();

interface ServerState {
  session: Session;
  token: string;
  startedAt: Date;
  background: boolean;
  profile?: string;
  busy: boolean;
  currentConversation: string | null;
  lastConversation: string | null;
}

export interface DaemonServerOptions {
  /** Stay in the foreground (don't redirect stdio). Used in dev. */
  foreground?: boolean;
  background?: boolean;
  profile?: string;
  /** Force a port instead of letting the OS pick. */
  port?: number;
}

export async function runDaemonServer(opts: DaemonServerOptions = {}): Promise<void> {
  log.info(`daemon-server starting (pid=${process.pid})`);

  const session = await openSession({
    headed: true, // we always need a real Chromium fingerprint
    profilePath: opts.profile,
    background: opts.background ?? true,
  });

  log.info("session open, going home…");
  await goHome(session.page);
  if (!(await isLoggedIn(session.page, 8_000))) {
    log.error("not logged in — refusing to start daemon");
    await session.close().catch(() => {});
    throw new NotLoggedInError();
  }
  log.info("auth verified, starting http listener");

  const state: ServerState = {
    session,
    token: randomBytes(32).toString("hex"),
    startedAt: new Date(),
    background: opts.background ?? true,
    profile: opts.profile,
    busy: false,
    currentConversation: null,
    lastConversation: null,
  };

  const server = createServer((req, res) => {
    handleRequest(req, res, state).catch((err: unknown) => {
      log.error(`unhandled: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      }
    });
  });
  // Disable Node's per-request timeout — long Pro turns may stream text
  // sporadically across the SSE channel, and we'd rather rely on
  // waitTurnComplete's deadline than the http.Server killing the response.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 0;

  // Bind on loopback only; the token covers same-host adversaries.
  server.listen(opts.port ?? 0, "127.0.0.1", () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const info: DaemonInfo = {
      version: 1,
      pid: process.pid,
      port,
      token: state.token,
      startedAt: state.startedAt.toISOString(),
      profile: opts.profile,
      background: opts.background ?? true,
    };
    writeDaemonInfo(info);
    log.info(`listening on 127.0.0.1:${port}`);
  });

  // Graceful shutdown on common signals.
  const shutdown = async (signal: string): Promise<never> => {
    log.info(`received ${signal} — shutting down`);
    server.close();
    await session.close().catch(() => {});
    clearDaemonInfo();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: ServerState,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1/");
  const method = req.method ?? "GET";

  // Healthz is the only un-authed route — clients use it to confirm
  // "this port belongs to a cgpro daemon" before sending the token.
  if (method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ daemon: "cgpro", version: 1 }));
    return;
  }

  if (!hasValidToken(req, state.token)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  if (method === "GET" && url.pathname === "/status") {
    const status: StatusResponse = {
      pid: process.pid,
      startedAt: state.startedAt.toISOString(),
      uptimeSec: Math.round((Date.now() - state.startedAt.getTime()) / 1000),
      background: state.background,
      profile: state.profile,
      busy: state.busy,
      currentConversation: state.currentConversation,
      lastConversation: state.lastConversation,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
    return;
  }

  if (method === "POST" && url.pathname === "/shutdown") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    setTimeout(() => {
      log.info("shutdown requested via /shutdown");
      void state.session.close().catch(() => {});
      clearDaemonInfo();
      process.exit(0);
    }, 50);
    return;
  }

  if (method === "POST" && url.pathname === "/ask") {
    await handleAsk(req, res, state);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
}

async function handleAsk(
  req: IncomingMessage,
  res: ServerResponse,
  state: ServerState,
): Promise<void> {
  if (state.busy) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "busy" }));
    return;
  }
  state.busy = true;

  try {
    const body = await readJsonBody<AskRequest>(req);
    if (!body || typeof body.prompt !== "string" || body.prompt.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_request" }));
      return;
    }
    // 4 hours upper bound — covers the longest GPT-5.5 Pro turns we've
    // seen in practice. Browser-side stays alive because the daemon owns
    // the persistent context and Node's http.Server has no inactivity
    // timeout once response headers are sent.
    const timeoutSec = Math.max(10, Math.min(14_400, body.timeoutSec ?? 7_200));

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const askOpts: AskOptions = {
      prompt: body.prompt,
      model: body.model,
      web: body.web,
      images: body.images ?? [],
      conversationId: body.conversationId,
      timeoutSec,
      headless: false,
      background: state.background,
      profile: state.profile,
    };

    const runner = runAskOnSession(askOpts, state.session);

    const writeEvent = (event: string, data: unknown): void => {
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        // Client disconnected — keep going so the conversation lands cleanly.
      }
    };

    let clientGone = false;
    res.on("close", () => {
      clientGone = true;
    });

    try {
      for await (const ev of runner.events) {
        if (ev.type === "started" && ev.conversationId) {
          state.currentConversation = ev.conversationId;
        }
        if (!clientGone) writeEvent(ev.type, ev);
      }
      const summary = await runner.result;
      state.lastConversation = summary.conversationId ?? state.currentConversation;
      if (!clientGone) {
        writeEvent("summary", {
          conversationId: summary.conversationId,
          finalText: summary.finalText,
        });
        res.end();
      }
    } catch (err) {
      log.error(`ask turn failed: ${(err as Error).message}`);
      if (!clientGone) {
        writeEvent("error", { message: (err as Error).message });
        res.end();
      }
    } finally {
      state.currentConversation = null;
    }
  } finally {
    state.busy = false;
  }
}

function hasValidToken(req: IncomingMessage, token: string): boolean {
  const auth = req.headers["authorization"];
  if (typeof auth !== "string") return false;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  // constant-time-ish equality; the token is hex so length is fixed
  if (m[1].length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= m[1].charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T | null> {
  return new Promise((resolve) => {
    let buf = "";
    req.setEncoding("utf-8");
    req.on("data", (chunk) => (buf += chunk));
    req.on("end", () => {
      if (buf.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(buf) as T);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function makeLogger(): { info: (m: string) => void; error: (m: string) => void } {
  try {
    mkdirSync(dirname(DAEMON_LOG), { recursive: true });
  } catch {
    /* swallow */
  }
  const fd = (() => {
    try {
      return openSync(DAEMON_LOG, "a");
    } catch {
      return -1;
    }
  })();
  const write = (level: string, m: string): void => {
    const line = `${new Date().toISOString()} [${level}] ${m}\n`;
    if (fd >= 0) {
      try {
        writeSync(fd, line);
        return;
      } catch {
        /* fall through */
      }
    }
    try {
      appendFileSync(DAEMON_LOG, line);
    } catch {
      /* swallow */
    }
  };
  return {
    info: (m) => write("info", m),
    error: (m) => write("error", m),
  };
}

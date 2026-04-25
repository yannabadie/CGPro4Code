import { chromium, type BrowserContext, type Page } from "playwright";
import { existsSync } from "node:fs";
import { ProfileLockedError } from "../errors.js";
import { profileDir, ensureDirs } from "../store/paths.js";
import { ensureInterceptorInstalled } from "../core/stream.js";

export interface SessionOptions {
  headed?: boolean;
  profilePath?: string;
  /** Use system Chrome via channel="chrome". Falls back to bundled Chromium if false. */
  useSystemChrome?: boolean;
}

export interface Session {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

/**
 * Launches a Chromium-based browser with a persistent profile.
 *
 * - First-time and login flows pass `headed: true` so the user can sign in
 *   and clear any 2FA / Cloudflare challenges.
 * - Subsequent runs reuse the same profile directory; the cookie jar and
 *   IndexedDB stay warm so headless operation works without re-challenges.
 * - The fetch interceptor for /backend-api/conversation is installed once
 *   per context BEFORE any navigation, so it catches the very first request.
 */
export async function openSession(opts: SessionOptions = {}): Promise<Session> {
  ensureDirs();
  const dir = profileDir(opts.profilePath);
  const headless = !(opts.headed ?? false);
  const useSystemChrome = opts.useSystemChrome ?? true;

  const launchArgs: string[] = [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
    "--lang=en-US,en",
  ];

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(dir, {
      headless,
      channel: useSystemChrome ? "chrome" : undefined,
      args: launchArgs,
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // Intentionally NOT setting userAgent: real Chrome already presents a
      // valid, current UA. Forcing a pinned string causes Cloudflare to
      // mismatch UA against client hints (sec-ch-ua) and fail the check.
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
    });
  } catch (err: unknown) {
    const msg = (err as Error).message ?? "";
    if (
      msg.includes("ProcessSingleton") ||
      msg.includes("user data directory is already in use") ||
      msg.includes("SingletonLock")
    ) {
      throw new ProfileLockedError();
    }
    if (useSystemChrome && (msg.includes("channel") || msg.includes("Executable doesn't exist"))) {
      // Retry with bundled Chromium.
      return openSession({ ...opts, useSystemChrome: false });
    }
    throw err;
  }

  // Strip the most obvious automation signal before any page loads.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // Install the SSE interceptor BEFORE any page navigation so the very
  // first /backend-api/conversation hit is captured.
  await ensureInterceptorInstalled(context);

  // Single tab per session.
  let page = context.pages()[0];
  if (!page) {
    page = await context.newPage();
  }

  return {
    context,
    page,
    async close() {
      await context.close().catch(() => {
        /* swallow close-time races */
      });
    },
  };
}

export function profileExists(profilePath?: string): boolean {
  const dir = profileDir(profilePath);
  return existsSync(dir) && existsSync(`${dir}/Default`);
}

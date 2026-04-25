import { chromium, type BrowserContext, type Page } from "playwright";
import { existsSync } from "node:fs";
import { ProfileLockedError } from "../errors.js";
import { profileDir, ensureDirs } from "../store/paths.js";

const CHATGPT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

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
      userAgent: CHATGPT_USER_AGENT,
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

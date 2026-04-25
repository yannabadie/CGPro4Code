// patchright is a drop-in Playwright fork that patches CDP leaks
// (navigator.webdriver, isolated-world detection, etc.). Both runtime
// and types come from patchright so Locator types stay compatible.
import { chromium, type BrowserContext, type Page } from "patchright";
import { existsSync } from "node:fs";
import { ProfileLockedError } from "../errors.js";
import { profileDir, ensureDirs } from "../store/paths.js";
import { ensureInterceptorInstalled } from "../core/stream.js";

export interface SessionOptions {
  headed?: boolean;
  profilePath?: string;
  /** Use system Chrome via channel="chrome". Falls back to bundled Chromium if false. */
  useSystemChrome?: boolean;
  /**
   * Open the browser window off-screen + minimized so the user doesn't see
   * a popup, while keeping the (auth-bearing) headed Chromium fingerprint.
   * Real headless mode gets challenged by Cloudflare.
   */
  background?: boolean;
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
  // Default to bundled Chromium: channel:"chrome" + launchPersistentContext
  // is flaky on Windows when the user's main Chrome is already open. Bundled
  // Chromium is dedicated and isolated; opt-in to system Chrome via env or
  // explicit flag.
  const useSystemChrome =
    opts.useSystemChrome ?? process.env.CGPRO_USE_CHROME === "1";

  // Patchright's stealth patches do most of the work. We add only:
  //   --password-store=basic  → avoid macOS keychain prompts (no-op on win)
  //   --lang=en-US,en         → consistent locale across launches
  // We deliberately do NOT add --disable-blink-features=AutomationControlled
  // (patchright handles blink-feature leaks differently and that flag would
  // re-introduce a sec-ch-ua signal Cloudflare checks for).
  const launchArgs: string[] = ["--password-store=basic", "--lang=en-US,en"];
  // Background mode: keep the headed Chromium fingerprint (Cloudflare
  // challenges headless), but park the window off-screen + minimised
  // so it never pops up in front of the user.
  const background = opts.background ?? process.env.CGPRO_BACKGROUND === "1";
  if (background && !headless) {
    launchArgs.push("--window-position=-32000,-32000", "--start-minimized");
  }

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(dir, {
      headless,
      channel: useSystemChrome ? "chrome" : undefined,
      args: launchArgs,
      // Strip Playwright's automation default flags so navigator.webdriver
      // is undefined and the UA doesn't include "HeadlessChrome" markers.
      ignoreDefaultArgs: ["--enable-automation"],
      viewport: null,
      locale: "en-US",
      timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // Intentionally NOT setting userAgent: real Chrome already presents a
      // valid, current UA; pinning it would mismatch sec-ch-ua headers.
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

  // Note: we don't override navigator.webdriver here. patchright already
  // does that at a deeper level (and stacking a Page-level override on top
  // creates a detectable inconsistency).

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

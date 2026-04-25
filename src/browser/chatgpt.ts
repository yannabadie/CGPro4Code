import type { Page, Locator } from "playwright";
import { SELECTORS, joinSelectors } from "./selectors.js";
import { SelectorBrokenError, BotChallengeError } from "../errors.js";

export const CHATGPT_HOME = "https://chatgpt.com/";

export async function goHome(page: Page, opts: { model?: string } = {}): Promise<void> {
  const url = new URL(CHATGPT_HOME);
  if (opts.model) {
    url.searchParams.set("model", opts.model);
  }
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  await detectBotChallenge(page);
}

/**
 * Returns true if the current page shows the logged-in app (composer present
 * or account menu visible). Polls up to `timeoutMs`.
 */
export async function isLoggedIn(page: Page, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const composer = await firstResolved(page, SELECTORS.composer);
    const account = await firstResolved(page, SELECTORS.accountMenu);
    if (composer || account) {
      return true;
    }
    const url = page.url();
    if (url.includes("/auth/login") || url.includes("/login")) {
      return false;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

/**
 * Try each candidate selector until one resolves to ≥1 visible element.
 * Returns the matching Locator or null.
 */
export async function firstResolved(page: Page, candidates: string[]): Promise<Locator | null> {
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    try {
      const count = await loc.count();
      if (count > 0) {
        return loc;
      }
    } catch {
      // try next
    }
  }
  return null;
}

export async function requireSelector(
  page: Page,
  candidates: string[],
  name: string,
  timeoutMs = 15_000,
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const loc = await firstResolved(page, candidates);
    if (loc) return loc;
    await page.waitForTimeout(250);
  }
  throw new SelectorBrokenError(name);
}

/**
 * Detect Cloudflare-style challenges or sentinel walls. Throws if found.
 */
export async function detectBotChallenge(page: Page): Promise<void> {
  const html = await page.content().catch(() => "");
  const flags = [
    "Just a moment",
    "challenge-platform",
    "cf-mitigated",
    "Verify you are human",
    "checking your browser",
  ];
  if (flags.some((f) => html.includes(f))) {
    throw new BotChallengeError();
  }
}

/**
 * Reads /api/auth/session via the page's request context (cookies attached).
 * Returns null if the call fails or the user is not authenticated.
 */
export interface AuthSession {
  user?: { email?: string; name?: string; image?: string };
  expires?: string;
  accessToken?: string;
}

export async function fetchAuthSession(page: Page): Promise<AuthSession | null> {
  try {
    const resp = await page.context().request.get(`${CHATGPT_HOME}api/auth/session`, {
      headers: { Accept: "application/json" },
      timeout: 10_000,
    });
    if (!resp.ok()) return null;
    const json = (await resp.json()) as AuthSession;
    if (!json || Object.keys(json).length === 0) return null;
    return json;
  } catch {
    return null;
  }
}

const joinSelectorsLocal = joinSelectors;
export { joinSelectorsLocal as joinSelectors };

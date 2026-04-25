import type { Page, Locator } from "patchright";
import { joinSelectors } from "./selectors.js";
import { SelectorBrokenError } from "../errors.js";

export const CHATGPT_HOME = "https://chatgpt.com/";

export async function goHome(page: Page, opts: { model?: string } = {}): Promise<void> {
  const url = new URL(CHATGPT_HOME);
  if (opts.model) {
    url.searchParams.set("model", opts.model);
  }
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  // Note: we don't probe for bot challenges here. The app loads
  // normally even when Cloudflare's beacon scripts are present in the
  // HTML, and any real interstitial usually self-resolves within a few
  // seconds for a real Chrome profile. The login/ask polling loops
  // detect failure-to-load via timeout instead.
}

/**
 * Returns true if the current account is actually authenticated.
 *
 * ChatGPT exposes an anonymous "Try ChatGPT" trial mode where the
 * composer is visible without a real login. The authoritative check is
 * GET /backend-api/me, but it must run from inside the page's JS
 * context — the React app injects an Authorization Bearer that
 * `page.context().request` does not have. We therefore use
 * `page.evaluate(fetch)`.
 *
 * `id: "user-XXX"` or non-empty email = authenticated.
 * `id: "ua-XXX"` with empty email = anonymous.
 *
 * As a fallback, presence of a known session cookie also flips us to true.
 */
export async function isLoggedIn(page: Page, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const me = await fetchMeInPage(page);
    if (me && (me.id?.startsWith("user-") || (me.email ?? "").length > 0)) {
      return true;
    }
    const cookies = await page
      .context()
      .cookies(["https://chatgpt.com/", "https://auth.openai.com/"])
      .catch(() => [] as Array<{ name: string; value: string }>);
    if (cookies.some((c) => /session-token|^_account$|cf_clearance/.test(c.name) && c.value.length > 0)) {
      // Cookie alone isn't proof of "user-…" auth, but combined with
      // the page being navigable, it's a good positive signal.
      if (me) return true;
    }
    await page.waitForTimeout(750);
  }
  return false;
}

/**
 * Fetches /backend-api/me from inside the page's JavaScript context.
 * This way the React app's `Authorization: Bearer …` header is attached.
 * Returns null on any error.
 */
export async function fetchMeInPage(page: Page): Promise<{
  id?: string;
  email?: string;
  name?: string;
  plan?: string;
  features?: string[];
} | null> {
  try {
    const result = await page.evaluate(async () => {
      try {
        const r = await fetch("/backend-api/me", {
          headers: { Accept: "application/json", "OAI-Language": "en-US" },
          credentials: "include",
        });
        if (!r.ok) return null;
        return (await r.json()) as Record<string, unknown>;
      } catch {
        return null;
      }
    });
    return (result ?? null) as never;
  } catch {
    return null;
  }
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
 * Detect a real Cloudflare interstitial (the user-visible "Just a moment"
 * page with no app content). Used by `cgpro doctor` and as a fallback
 * heuristic — NOT in the goHome critical path, since the legitimate
 * chatgpt.com page also embeds Cloudflare beacon scripts.
 */
export async function detectBotChallenge(page: Page): Promise<boolean> {
  const html = await page.content().catch(() => "");
  // Real interstitial: page body shows challenge UI AND no composer / no
  // login form (i.e. nothing of the actual app rendered).
  const hasInterstitialUi =
    html.includes("Just a moment") ||
    html.includes("Verify you are human") ||
    html.includes("checking your browser");
  if (!hasInterstitialUi) return false;
  const composer = await firstResolved(page, [
    "#prompt-textarea",
    '[data-testid="prompt-textarea"]',
  ]);
  const loginLink = await firstResolved(page, [
    'a[href*="login"]',
    'input[type="email"]',
  ]);
  return !composer && !loginLink;
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

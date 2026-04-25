import type { Page, Locator } from "playwright";
import { SELECTORS } from "./selectors.js";
import { firstResolved, requireSelector } from "./chatgpt.js";

/**
 * Open a fresh conversation with a target model.
 *
 * Strategy:
 *   1. Navigate to chatgpt.com/?model=<slug>&temporary-chat=false
 *   2. Wait for composer to appear.
 *   3. If the active model differs from `desiredModel`, open the picker
 *      and click the matching item.
 */
export async function openConversation(
  page: Page,
  opts: { model?: string; conversationId?: string } = {},
): Promise<void> {
  if (opts.conversationId) {
    await page.goto(`https://chatgpt.com/c/${opts.conversationId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
  } else {
    const url = new URL("https://chatgpt.com/");
    url.searchParams.set("temporary-chat", "false");
    if (opts.model) url.searchParams.set("model", opts.model);
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  }

  await requireSelector(page, SELECTORS.composer, "composer", 20_000);

  if (opts.model) {
    await tryEnsureModel(page, opts.model);
  }
}

async function tryEnsureModel(page: Page, slug: string): Promise<void> {
  const trigger = await firstResolved(page, SELECTORS.modelSwitcher);
  if (!trigger) return; // Picker absent — deep link must have stuck.
  const text = (await trigger.textContent())?.toLowerCase() ?? "";
  if (text.includes(slug.toLowerCase()) || text.includes("pro")) {
    return;
  }
  try {
    await trigger.click({ timeout: 5_000 });
    // Look for any menu item containing the slug (case-insensitive).
    const candidate = page
      .locator(`[role="menuitem"], [data-testid^="model-switcher-"], li:has-text("Pro")`)
      .filter({ hasText: new RegExp(slug.replace(/[.-]/g, "[.-]?"), "i") })
      .first();
    if ((await candidate.count()) > 0) {
      await candidate.click({ timeout: 5_000 }).catch(() => {});
      return;
    }
    const proItem = page
      .locator(`[role="menuitem"]:has-text("Pro"), li:has-text("5.5 Pro"), li:has-text("5 Pro")`)
      .first();
    if ((await proItem.count()) > 0) {
      await proItem.click({ timeout: 5_000 }).catch(() => {});
    }
  } catch {
    // Picker click failed — proceed with current model.
  } finally {
    // Close the picker if it's still open by pressing Escape.
    await page.keyboard.press("Escape").catch(() => {});
  }
}

/**
 * Toggle the composer's web-search button until aria-pressed matches `on`.
 * No-op if the toggle isn't present (some accounts/locales hide it).
 */
export async function setWebSearch(page: Page, on: boolean): Promise<void> {
  const toggle = await firstResolved(page, SELECTORS.webSearchToggle);
  if (!toggle) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    const pressed = (await toggle.getAttribute("aria-pressed")) === "true";
    if (pressed === on) return;
    await toggle.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(250);
  }
}

/**
 * Type the prompt into the composer (preserving newlines via Shift+Enter)
 * and click Send. Returns when the request has been issued.
 */
export async function sendPrompt(page: Page, prompt: string): Promise<void> {
  const composer = await requireSelector(page, SELECTORS.composer, "composer");
  await composer.click();
  // Some composers are contenteditable. Use page.keyboard for fidelity.
  const lines = prompt.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(lines[i], { delay: 1 });
  }

  const send = await requireSelector(page, SELECTORS.sendButton, "sendButton", 5_000);
  await send.click({ timeout: 5_000 });
}

/**
 * Returns the conversation UUID if the page is on /c/<uuid>, else null.
 */
export function currentConversationId(page: Page): string | null {
  const u = page.url();
  const m = u.match(/\/c\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

/**
 * Wait until the assistant has finished streaming. Heuristic: stop button
 * disappears AND streaming attribute on the latest assistant bubble flips off.
 */
export async function waitTurnComplete(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stop = await firstResolved(page, SELECTORS.stopButton);
    const bubble = await latestAssistantBubble(page);
    let streaming = false;
    if (stop) streaming = true;
    if (bubble) {
      const attr = await bubble.getAttribute("data-message-streaming").catch(() => null);
      if (attr === "true") streaming = true;
    }
    if (!streaming) {
      // Wait one more tick to be sure the stream finalized the network.
      await page.waitForTimeout(250);
      return;
    }
    await page.waitForTimeout(250);
  }
  throw new Error("Turn did not complete in time");
}

export async function latestAssistantBubble(page: Page): Promise<Locator | null> {
  const all = page.locator(SELECTORS.assistantMessages.join(", "));
  const n = await all.count();
  if (n === 0) return null;
  return all.nth(n - 1);
}

/**
 * Fall-back content extraction: return the latest assistant bubble's
 * inner text. Used when SSE interception didn't capture text.
 */
export async function readLatestAssistantText(page: Page): Promise<string> {
  const bubble = await latestAssistantBubble(page);
  if (!bubble) return "";
  return (await bubble.innerText().catch(() => "")) ?? "";
}

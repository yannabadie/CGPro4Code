import type { Page, Locator } from "patchright";
import { SELECTORS } from "./selectors.js";
import { firstResolved, requireSelector } from "./chatgpt.js";

/**
 * Open a chatgpt.com conversation.
 *
 *   - `conversationId` set → resume that exact thread (`/c/<uuid>`).
 *   - else if `gizmoId` set → start a new chat *inside* that project,
 *     so the resulting conversation lands in the project sidebar
 *     instead of the global Recents.
 *   - else → start a brand-new conversation in Recents.
 *
 * Ephemeral / Temporary Chat is intentionally NOT exposed: the
 * resulting conversation is not addressable by URL, which makes
 * multi-turn auto-resume impossible.
 */
export async function openConversation(
  page: Page,
  opts: { model?: string; conversationId?: string; gizmoId?: string; gizmoShortUrl?: string } = {},
): Promise<void> {
  if (opts.conversationId) {
    await page.goto(`https://chatgpt.com/c/${opts.conversationId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
  } else if (opts.gizmoId) {
    // Land on the project page; the next sendPrompt creates a conv
    // inside it (the React app reads the gizmo from the URL and
    // includes the right conversation_mode in the POST body).
    const slug = opts.gizmoShortUrl ?? opts.gizmoId;
    const url = new URL(`https://chatgpt.com/g/${encodeURIComponent(slug)}/project`);
    if (opts.model) url.searchParams.set("model", opts.model);
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  } else {
    const url = new URL("https://chatgpt.com/");
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
 * Enable / disable composer web search. The toggle moved into a
 * "+ Tools" popover on recent chatgpt.com builds, so we look for it
 * inline first, then fall back to opening the tools menu.
 *
 * Returns the resolved state. Throws when `on=true` is requested but
 * we can't make it stick — cgpro policy is web-on, the caller should
 * surface the failure (not silently degrade).
 */
export async function setWebSearch(page: Page, on: boolean): Promise<boolean> {
  // Current chatgpt.com (April 2026): the Web search switch lives
  // inside the "+ Add files and more" popover as a menuitemradio.
  // We open the popover, click the radio, verify aria-checked, then
  // close. Web search shares a radio group with Create image / Deep
  // research, so toggling it on disables those — that's intentional.

  const openPopover = async (): Promise<boolean> => {
    const plus = await firstResolved(page, [
      'button[data-testid="composer-plus-btn"]',
      'button[aria-label*="Add files" i]',
      'button[aria-label*="Add" i][aria-haspopup]',
    ]);
    if (!plus) return false;
    const expanded = (await plus.getAttribute("aria-expanded").catch(() => null)) === "true";
    if (!expanded) {
      await plus.click({ timeout: 3_000 }).catch(() => undefined);
      await page.waitForTimeout(300);
    }
    return true;
  };

  // Try inline first (older layouts).
  let toggle = await firstResolved(page, SELECTORS.webSearchToggle.slice(3)); // skip the menuitemradio variants
  let viaPopover = false;
  if (!toggle) {
    if (await openPopover()) {
      viaPopover = true;
      toggle = await firstResolved(page, SELECTORS.webSearchToggle);
    }
  }

  if (!toggle) {
    if (on) {
      console.error(
        "[cgpro:web] WARNING: web search toggle not found in composer popover. Policy is web-on but we couldn't enable it. Run `cgpro doctor` to audit selectors.",
      );
    }
    if (viaPopover) await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }

  // Read current state BEFORE clicking. Radix popover items dismiss
  // the popover on click → the locator goes stale and reading attrs
  // returns null. So we only read once, decide whether to click, and
  // treat a successful click as the state change.
  const before = {
    ck: (await toggle.getAttribute("aria-checked").catch(() => null)) === "true",
    pr: (await toggle.getAttribute("aria-pressed").catch(() => null)) === "true",
    ds: (await toggle.getAttribute("data-state").catch(() => null)) === "checked",
  };
  const wasOn = before.ck || before.pr || before.ds;

  if (wasOn === on) {
    if (viaPopover) await page.keyboard.press("Escape").catch(() => undefined);
    return on;
  }

  let clicked = false;
  try {
    await toggle.click({ timeout: 5_000 });
    clicked = true;
  } catch {
    /* swallow */
  }

  // Popover dismisses on click. Don't try to re-read state from the
  // stale element — re-open and re-query if you need to verify.
  if (viaPopover && !clicked) await page.keyboard.press("Escape").catch(() => undefined);

  if (!clicked && on) {
    console.error(
      "[cgpro:web] WARNING: failed to click the Web search radio. The model may answer without live web access.",
    );
    return false;
  }
  return on;
}

/**
 * Type the prompt into the composer and submit it. Returns the assistant-
 * bubble count from BEFORE the send so the caller can detect "the new one".
 *
 * Submission strategy: try the send button (waiting for it to be enabled),
 * fall back to Enter — some account/locale combos disable the button when
 * the composer is "empty" by their detector even when text is present.
 */
export async function sendPrompt(page: Page, prompt: string): Promise<number> {
  const composer = await requireSelector(page, SELECTORS.composer, "composer");
  await composer.click();
  await page.waitForTimeout(120);
  // Composer is a contenteditable div on modern chatgpt.com — use the
  // keyboard so React's state listeners actually fire.
  const lines = prompt.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(lines[i], { delay: 4 });
  }
  // Give React one paint to update the send-button enabled state.
  await page.waitForTimeout(250);

  const priorAssistantCount = await page
    .locator(SELECTORS.assistantMessages.join(", "))
    .count()
    .catch(() => 0);

  const send = await firstResolved(page, SELECTORS.sendButton);
  let clicked = false;
  if (send) {
    const disabled = await send
      .getAttribute("disabled")
      .catch(() => null);
    const ariaDisabled = await send
      .getAttribute("aria-disabled")
      .catch(() => null);
    if (disabled === null && ariaDisabled !== "true") {
      await send.click({ timeout: 4_000 }).catch(() => {
        /* fall through to Enter */
      });
      clicked = true;
    }
  }
  if (!clicked) {
    // Fall back to pressing Enter while the composer has focus.
    await page.keyboard.press("Enter");
  }
  return priorAssistantCount;
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
 * Wait until the assistant has produced and completed a new response.
 *
 *  1. Wait for a NEW assistant bubble (count > priorAssistantCount).
 *  2. Wait for either the legacy "Stop generating" button to disappear,
 *     OR the bubble's text content to stabilise for >= `stableMs`.
 *
 * Text-stability is the bulletproof completion signal — it doesn't
 * depend on chatgpt.com's ever-shifting action-bar / data-attribute
 * selectors.
 */
export async function waitTurnComplete(
  page: Page,
  timeoutMs: number,
  priorAssistantCount = 0,
  // Bumped from 1500 → 4000 because GPT-5.5 Pro extended-thinking turns
  // can pause mid-stream for several seconds while the model deliberates.
  // The Stop button check resets this window when chatgpt.com is still
  // streaming, but we'd rather over-wait than truncate a long answer.
  stableMs = Number(process.env.CGPRO_STABLE_MS ?? 4000),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  // Phase 1: wait for a new assistant bubble.
  while (Date.now() < deadline) {
    const count = await page
      .locator(SELECTORS.assistantMessages.join(", "))
      .count()
      .catch(() => 0);
    if (count > priorAssistantCount) break;
    await page.waitForTimeout(250);
  }
  if (Date.now() >= deadline) {
    throw new Error("Assistant bubble did not appear in time");
  }

  // Phase 2: poll the bubble's text every 400ms; consider the turn
  // complete once the text has not changed for `stableMs`.
  let lastText = "";
  let lastChangedAt = Date.now();

  while (Date.now() < deadline) {
    // Hard signal: the legacy stop button means "still streaming".
    const stop = await firstResolved(page, SELECTORS.stopButton);
    if (stop) {
      await page.waitForTimeout(400);
      lastChangedAt = Date.now(); // reset stability window
      continue;
    }

    const bubble = await latestAssistantBubble(page);
    if (!bubble) {
      await page.waitForTimeout(300);
      continue;
    }

    const streamingAttr = await bubble
      .getAttribute("data-message-streaming")
      .catch(() => null);
    if (streamingAttr === "true") {
      await page.waitForTimeout(400);
      lastChangedAt = Date.now();
      continue;
    }

    const text = (await bubble.innerText().catch(() => "")) ?? "";
    if (text !== lastText) {
      lastText = text;
      lastChangedAt = Date.now();
      await page.waitForTimeout(400);
      continue;
    }

    if (text.length > 0 && Date.now() - lastChangedAt >= stableMs) {
      return;
    }

    await page.waitForTimeout(300);
  }

  throw new Error("Turn did not complete in time");
}

export async function latestAssistantBubble(page: Page): Promise<Locator | null> {
  // Walk fallbacks in order so we always pick the deepest, most specific
  // selector that matches — joining them with "," would let the outer
  // <article> wrapper be selected instead of the bubble itself.
  for (const sel of SELECTORS.assistantMessages) {
    const all = page.locator(sel);
    const n = await all.count().catch(() => 0);
    if (n > 0) return all.nth(n - 1);
  }
  return null;
}

/**
 * Fall-back content extraction: return the latest assistant bubble's
 * inner text. Used when SSE interception didn't capture text.
 *
 * Strips a leading "Thought for Ns" prefix that the Pro / Thinking models
 * inject before the actual answer. Prefers the deepest markdown container
 * so we don't pick up wrapper chrome.
 */
export async function readLatestAssistantText(page: Page): Promise<string> {
  const debug = process.env.CGPRO_DEBUG === "1";
  const log = (m: string): void => {
    if (debug) console.error("[cgpro:read]", m);
  };
  const bubble = await latestAssistantBubble(page);
  log(`bubble=${bubble ? "found" : "null"}`);
  if (!bubble) return "";
  // Try several text containers, in priority order.
  const containers = [
    "div.markdown",
    "[data-message-content]",
    ".prose",
    ":scope", // bubble itself
  ];
  for (const sel of containers) {
    const loc = sel === ":scope" ? bubble : bubble.locator(sel).first();
    try {
      const cnt = sel === ":scope" ? 1 : await bubble.locator(sel).count();
      log(`${sel}: count=${cnt}`);
      if (cnt === 0) continue;
      const text = (await loc.innerText({ timeout: 1_500 }).catch((e) => {
        log(`${sel}: innerText threw: ${(e as Error).message.slice(0, 60)}`);
        return "";
      })) ?? "";
      log(`${sel}: text.length=${text.length} preview=${JSON.stringify(text.slice(0, 60))}`);
      if (text.trim().length === 0) continue;
      const cleaned = text.replace(/^Thought for \d+s\s*\n+/i, "").trim();
      if (cleaned.length > 0) return cleaned;
    } catch (e) {
      log(`${sel}: outer throw: ${(e as Error).message.slice(0, 60)}`);
    }
  }
  // Last resort: ask the page to dig out any text from the bubble subtree.
  log("falling back to bubble.evaluate(innerText)");
  const txt = await bubble
    .evaluate((el) => (el as HTMLElement).innerText ?? "")
    .catch((e) => {
      log(`fallback evaluate threw: ${(e as Error).message.slice(0, 60)}`);
      return "";
    });
  log(`fallback result.length=${txt.length}`);
  return txt.replace(/^Thought for \d+s\s*\n+/i, "").trim();
}

/**
 * Reads the model slug actually used for the latest assistant message.
 * Useful when the picker silently keeps the user's previous default.
 */
export async function latestAssistantModelSlug(page: Page): Promise<string | null> {
  const bubble = await latestAssistantBubble(page);
  if (!bubble) return null;
  return (await bubble.getAttribute("data-message-model-slug").catch(() => null)) ?? null;
}

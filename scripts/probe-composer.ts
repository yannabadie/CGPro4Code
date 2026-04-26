/**
 * Diagnostic: open the project page (or home), dump every button and
 * menu trigger near the composer with their aria-labels + testids
 * so we can find the web-search toggle in the current chatgpt.com layout.
 */
import { openSession } from "../src/browser/session.js";
import { goHome, getAccessToken } from "../src/browser/chatgpt.js";

async function main(): Promise<void> {
  const target = process.argv[2] ?? "https://chatgpt.com/";
  const session = await openSession({ headed: true, background: true });
  try {
    await goHome(session.page);
    const tok = await getAccessToken(session.page);
    if (!tok) {
      console.error("NOT LOGGED IN");
      process.exit(2);
    }
    await session.page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await session.page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    await session.page.waitForSelector("#prompt-textarea, [data-testid=\"prompt-textarea\"]", { timeout: 10_000 }).catch(() => undefined);

    // Click the "+" composer button to expose the popover items
    await session.page
      .locator('button[data-testid="composer-plus-btn"]')
      .first()
      .click({ timeout: 3_000 })
      .catch(() => undefined);
    await session.page.waitForTimeout(500);

    const buttons = await session.page.evaluate(() => {
      const out: Array<{
        tag: string;
        testid: string | null;
        ariaLabel: string | null;
        role: string | null;
        text: string;
      }> = [];
      // Globally — popovers render in portals outside the composer surface.
      document.querySelectorAll(
        "[role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [data-radix-collection-item]",
      ).forEach((el) => {
        out.push({
          tag: el.tagName,
          testid: el.getAttribute("data-testid"),
          ariaLabel: el.getAttribute("aria-label"),
          role: el.getAttribute("role"),
          text: ((el as HTMLElement).innerText ?? "").trim().slice(0, 100),
        });
      });
      return { url: window.location.href, count: out.length, items: out };
    });
    console.log(JSON.stringify(buttons, null, 2));
  } finally {
    await session.close();
  }
}

void main();

/**
 * Diagnostic: open the cgpro profile, navigate to chatgpt.com, and dump
 * what Chromium ACTUALLY exposes as cookies for the chatgpt domain.
 *
 * If session-token cookies have empty `value` strings, our Chromium
 * couldn't decrypt the imported encrypted_value blobs (DPAPI mismatch).
 * If they have the JWT but /me still returns ua-X, something else is
 * stripping/rejecting them.
 */
import { openSession } from "../src/browser/session.js";
import { goHome } from "../src/browser/chatgpt.js";

async function main(): Promise<void> {
  const session = await openSession({ headed: true, background: true });
  try {
    await goHome(session.page);
    await session.page
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => undefined);

    const cookies = await session.context.cookies([
      "https://chatgpt.com/",
      "https://auth.openai.com/",
    ]);
    console.log("=== Cookies the Chromium loaded for chatgpt.com / auth.openai.com ===");
    for (const c of cookies) {
      const tag = c.value && c.value.length > 0 ? `len=${c.value.length}` : "EMPTY";
      console.log(`  ${c.name.padEnd(40)} ${tag.padEnd(12)} domain=${c.domain}`);
    }
    console.log(`Total cookies: ${cookies.length}`);

    const sessionToken = cookies.find((c) => c.name.includes("session-token"));
    if (sessionToken && sessionToken.value && sessionToken.value.length > 0) {
      console.log(
        `\nsession-token IS readable (${sessionToken.value.length} chars). DPAPI decryption SUCCEEDED.`,
      );
    } else if (sessionToken) {
      console.log(`\nsession-token is EMPTY — DPAPI decryption FAILED on this cookie.`);
    } else {
      console.log(`\nNo session-token cookie loaded at all.`);
    }

    // Step A: cookie-only call to /backend-api/me (no Bearer)
    const meCookieOnly = await session.page.evaluate(async () => {
      const r = await fetch("/backend-api/me", { credentials: "include" });
      return r.ok ? await r.json() : { error: r.status };
    });
    console.log("\n=== /backend-api/me (cookie only) ===");
    console.log(JSON.stringify(meCookieOnly, null, 2));

    // Step B: fetch /api/auth/session to extract accessToken (Bearer JWT)
    const session401 = await session.page.evaluate(async () => {
      const r = await fetch("/api/auth/session", { credentials: "include" });
      return { status: r.status, body: r.ok ? await r.json() : null };
    });
    console.log("\n=== /api/auth/session (TOP-LEVEL KEYS) ===");
    if (session401.body && typeof session401.body === "object") {
      const b = session401.body as Record<string, unknown>;
      console.log("keys:", Object.keys(b).join(", "));
      console.log("user:", JSON.stringify((b as { user?: unknown }).user, null, 2));
      console.log("expires:", (b as { expires?: unknown }).expires);
      console.log("accessToken (first 40 chars):", typeof b.accessToken === "string" ? b.accessToken.slice(0, 40) + "..." : b.accessToken);
    }

    // Step C: if we got an accessToken, retry /backend-api/me with it
    const accessToken = (session401 as { body?: { accessToken?: string } }).body?.accessToken;
    if (accessToken) {
      const meWithBearer = await session.page.evaluate(async (token) => {
        const r = await fetch("/backend-api/me", {
          credentials: "include",
          headers: { Authorization: `Bearer ${token}` },
        });
        return r.ok ? await r.json() : { error: r.status };
      }, accessToken);
      console.log("\n=== /backend-api/me (WITH Bearer from /api/auth/session) ===");
      console.log(JSON.stringify(meWithBearer, null, 2));
    } else {
      console.log("\n(no accessToken in session — can't retry with Bearer)");
    }

    // Step D: dump first 200 chars of the page DOM to see what UI loaded
    const titleAndUrl = await session.page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      hasComposer: !!document.querySelector('#prompt-textarea'),
      hasLoginLink: !!document.querySelector('a[href*="login"]'),
      bodyText: (document.body?.innerText ?? "").slice(0, 300),
    }));
    console.log("\n=== Page state ===");
    console.log(JSON.stringify(titleAndUrl, null, 2));
  } finally {
    await session.close();
  }
}

void main();

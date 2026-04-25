import chalk from "chalk";
import ora from "ora";
import { openSession } from "../../browser/session.js";
import { goHome } from "../../browser/chatgpt.js";
import { assertNoDaemon } from "../../daemon/client.js";

export interface LoginOptions {
  profile?: string;
  timeout?: number;
}

interface MeProbe {
  id?: string;
  email?: string;
  plan?: string;
  features?: string[];
}

/**
 * Login flow:
 *   1. Open Chrome headed against the persistent profile.
 *   2. Navigate to chatgpt.com.
 *   3. Poll /backend-api/me every 2s. The endpoint always returns 200,
 *      but the `id` field discriminates: "user-XXX" = real account,
 *      "ua-XXX" = anonymous trial. We close the browser only when we
 *      see "user-XXX", so the user has all the time they need.
 */
export async function loginCommand(opts: LoginOptions): Promise<number> {
  await assertNoDaemon("login");
  const timeoutSec = opts.timeout ?? 300;
  const startedAt = Date.now();

  console.log(chalk.bold("Opening Chromium…"));
  console.log("");
  console.log("  1. Sign in to your ChatGPT account in the browser window.");
  console.log("  2. The browser closes by itself the moment login is detected.");
  console.log("");

  const session = await openSession({ headed: true, profilePath: opts.profile });
  const spinner = ora("Waiting for sign-in…").start();

  try {
    await goHome(session.page);

    const deadline = startedAt + timeoutSec * 1000;
    let lastSpinnerUpdate = 0;
    while (Date.now() < deadline) {
      const status = await detectAuth(session.page, session.context);
      if (status.authenticated) {
        spinner.succeed("Signed in — closing browser.");
        const email = status.me?.email ?? "(unknown)";
        const plan = status.me ? derivedPlan(status.me) : "(unknown)";
        console.log("");
        console.log(chalk.green("✔ Logged in"));
        console.log(`  ${chalk.bold("Account:")}  ${email}`);
        console.log(`  ${chalk.bold("Plan:")}     ${plan}`);
        console.log("");
        console.log(
          chalk.dim('Profile is now warm. Run `cgpro status`, then `cgpro ask "..."`.'),
        );
        return 0;
      }
      const now = Date.now();
      if (now - lastSpinnerUpdate > 1_500) {
        const elapsed = Math.round((now - startedAt) / 1000);
        spinner.text = `Waiting for sign-in… (${elapsed}s)`;
        lastSpinnerUpdate = now;
      }
      // Tight 1s loop so the browser closes ~immediately after login.
      await session.page.waitForTimeout(1_000);
    }

    spinner.fail(`Timed out after ${timeoutSec}s — still anonymous.`);
    console.log("");
    console.log(
      chalk.yellow(
        'Common cause: the "Try ChatGPT" guest mode shows the composer\n' +
          'without an actual login. Look for the "Log in" button at the\n' +
          "top right and complete a real sign-in flow.",
      ),
    );
    return 7;
  } finally {
    await session.close();
  }
}

interface AuthStatus {
  authenticated: boolean;
  me?: MeProbe;
  reason?: string;
}

/**
 * Robust auth detection that combines two independent signals:
 *   1. /backend-api/me returns a real user (`id: user-…` or non-empty email)
 *   2. The browser context holds a known session cookie
 *
 * We accept either signal — schemas drift, cookie names drift, but the two
 * together cover any single-vendor change.
 */
async function detectAuth(
  page: import("patchright").Page,
  context: import("patchright").BrowserContext,
): Promise<AuthStatus> {
  const me = (await fetchMe(page)) ?? undefined;
  if (me && isAuthenticatedByApi(me)) {
    return { authenticated: true, me, reason: "api" };
  }
  const cookies = await context.cookies(["https://chatgpt.com/", "https://auth.openai.com/"]);
  const sessionCookie = cookies.find(
    (c) =>
      c.name.includes("session-token") ||
      c.name === "__Secure-next-auth.session-token" ||
      c.name === "__Host-next-auth.csrf-token" ||
      (c.name === "_account" && c.value.length > 0),
  );
  if (sessionCookie) {
    return { authenticated: true, me, reason: `cookie:${sessionCookie.name}` };
  }
  return { authenticated: false, me };
}

async function fetchMe(page: import("patchright").Page): Promise<MeProbe | null> {
  try {
    const resp = await page.context().request.get(
      "https://chatgpt.com/backend-api/me",
      {
        headers: { Accept: "application/json", "OAI-Language": "en-US" },
        timeout: 6_000,
      },
    );
    if (!resp.ok()) return null;
    return (await resp.json()) as MeProbe;
  } catch {
    return null;
  }
}

function isAuthenticatedByApi(me: MeProbe): boolean {
  const id = me.id ?? "";
  const email = me.email ?? "";
  return id.startsWith("user-") || email.length > 0;
}

function derivedPlan(me: MeProbe): string {
  if (me.plan) return me.plan;
  const blob = (me.features ?? []).join(",").toLowerCase();
  if (blob.includes("pro")) return "pro";
  if (blob.includes("business")) return "business";
  if (blob.includes("enterprise")) return "enterprise";
  if (blob.includes("plus")) return "plus";
  return "(unknown)";
}

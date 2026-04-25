import chalk from "chalk";
import ora from "ora";
import { openSession } from "../../browser/session.js";
import { fetchAuthSessionInPage, goHome, type AuthSessionFull } from "../../browser/chatgpt.js";
import { assertNoDaemon } from "../../daemon/client.js";

export interface LoginOptions {
  profile?: string;
  timeout?: number;
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

  // Login MUST show the window so the user can sign in.
  const session = await openSession({ headed: true, background: false, profilePath: opts.profile });
  const spinner = ora("Waiting for sign-in…").start();

  try {
    // Land directly on the dedicated login page rather than chatgpt.com/.
    // The home URL drops into "Try ChatGPT" trial mode for blank profiles
    // and the user can mistake the trial composer for a real session.
    await session.page
      .goto("https://chatgpt.com/auth/login", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      .catch(() => goHome(session.page));

    const deadline = startedAt + timeoutSec * 1000;
    let lastSpinnerUpdate = 0;
    while (Date.now() < deadline) {
      const sess = await fetchAuthSessionInPage(session.page);
      if (sess?.user?.id?.startsWith("user-")) {
        spinner.succeed("Signed in — closing browser.");
        console.log("");
        console.log(chalk.green("✔ Logged in"));
        console.log(`  ${chalk.bold("Account:")}  ${sess.user.email ?? "(no email)"}`);
        console.log(`  ${chalk.bold("Name:")}     ${sess.user.name ?? "(no name)"}`);
        if (sess.expires) {
          console.log(`  ${chalk.bold("Expires:")}  ${new Date(sess.expires).toLocaleString()}`);
        }
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

// Auth detection now lives in browser/chatgpt.ts (fetchAuthSessionInPage)
// — the in-page /api/auth/session call is the only signal that
// reliably discriminates anonymous trial sessions from real ones.
export type _LoginInternalsKept = AuthSessionFull;

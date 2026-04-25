import chalk from "chalk";
import ora from "ora";
import { openSession } from "../../browser/session.js";
import { fetchAuthSession, goHome, isLoggedIn } from "../../browser/chatgpt.js";

export interface LoginOptions {
  profile?: string;
  timeout?: number;
}

export async function loginCommand(opts: LoginOptions): Promise<number> {
  const timeoutSec = opts.timeout ?? 300;
  console.log(chalk.cyan("Opening Chrome — please sign in to your ChatGPT account."));
  console.log(
    chalk.dim("Once you reach the chat home screen, this command will detect it and exit.\n"),
  );

  const session = await openSession({ headed: true, profilePath: opts.profile });
  const spinner = ora("Waiting for sign-in…").start();

  try {
    await goHome(session.page);

    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (await isLoggedIn(session.page, 2_000)) {
        spinner.succeed("Detected logged-in session.");
        const auth = await fetchAuthSession(session.page);
        const email = auth?.user?.email ?? "(unknown email)";
        const expires = auth?.expires ? new Date(auth.expires).toLocaleString() : "(unknown)";
        console.log("");
        console.log(chalk.green("✔ Logged in"));
        console.log(`  ${chalk.bold("Account:")}  ${email}`);
        console.log(`  ${chalk.bold("Expires:")}  ${expires}`);
        console.log("");
        console.log(chalk.dim("Profile saved at:"), opts.profile ?? "(default)");
        console.log(chalk.dim("Run `cgpro ask \"...\"` to send a prompt."));
        return 0;
      }
      await session.page.waitForTimeout(1500);
    }

    spinner.fail("Timed out waiting for sign-in.");
    console.error(
      chalk.yellow(
        `\nNo logged-in session detected within ${timeoutSec}s. Re-run \`cgpro login\` and complete the flow in the browser window.`,
      ),
    );
    return 7;
  } finally {
    await session.close();
  }
}

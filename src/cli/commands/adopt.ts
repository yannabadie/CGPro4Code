import chalk from "chalk";
import ora from "ora";
import {
  clearProfile,
  findChatGptApp,
  importAppProfile,
  isAppRunning,
  killApp,
} from "../../desktop/chatgpt-app.js";
import { ensureDirs, profileDir } from "../../store/paths.js";
import { openSession } from "../../browser/session.js";
import { goHome, isLoggedIn, fetchMeInPage } from "../../browser/chatgpt.js";
import { assertNoDaemon } from "../../daemon/client.js";

export interface AdoptOptions {
  profile?: string;
  killApp?: boolean;
}

/**
 * `cgpro adopt` — import the desktop ChatGPT app's authenticated session
 * into the cgpro profile. After this, every cgpro command runs as the
 * signed-in account with no separate login flow.
 */
export async function adoptCommand(opts: AdoptOptions): Promise<number> {
  await assertNoDaemon("adopt");
  const app = findChatGptApp();
  if (!app) {
    console.error(chalk.red("✖ ChatGPT desktop app not found."));
    console.error(
      chalk.dim(
        "Install it from the Microsoft Store, sign in once, then re-run `cgpro adopt`.",
      ),
    );
    return 1;
  }

  console.log(chalk.bold("Found:"), app.label);
  console.log(chalk.dim("       " + app.dataDir));
  console.log("");

  if (await isAppRunning()) {
    if (opts.killApp) {
      const spinner = ora("Closing ChatGPT app…").start();
      const killed = await killApp();
      spinner.stop();
      if (!killed) {
        console.error(chalk.red("✖ Could not close ChatGPT.exe automatically."));
        return 1;
      }
      // Give Windows a beat to release file locks.
      await new Promise((r) => setTimeout(r, 1500));
    } else {
      console.error(
        chalk.yellow(
          "⚠ ChatGPT app is running — its profile files are locked.",
        ),
      );
      console.error(
        chalk.dim(
          "Close the app (system tray icon → Quit) and re-run, or pass `--kill-app` to force.",
        ),
      );
      return 2;
    }
  }

  ensureDirs();
  const dir = profileDir(opts.profile);

  const spinner = ora("Importing app session into cgpro profile…").start();
  try {
    clearProfile(dir);
    const { copied, skipped } = importAppProfile(app.dataDir, dir);
    spinner.succeed(`Imported ${copied.length} artifact(s).`);
    if (copied.length > 0) {
      console.log(chalk.dim("  ✓ " + copied.join(", ")));
    }
    if (skipped.length > 0) {
      console.log(chalk.dim("  · skipped: " + skipped.join(", ")));
    }
  } catch (err) {
    spinner.fail(`Copy failed: ${(err as Error).message}`);
    return 1;
  }

  // Smoke-check the imported session.
  const verifySpinner = ora("Verifying session…").start();
  const session = await openSession({ headed: false, profilePath: opts.profile });
  try {
    await goHome(session.page);
    const ok = await isLoggedIn(session.page, 15_000);
    if (!ok) {
      verifySpinner.warn(
        "Session imported but does not yet test as authenticated. Try `cgpro status`.",
      );
      return 0;
    }
    const me = await fetchMeInPage(session.page);
    verifySpinner.succeed("Session is authenticated.");
    const email = me?.email && me.email.length > 0 ? me.email : "(no email exposed)";
    console.log("");
    console.log(chalk.green("✔ Adopted"));
    console.log(`  ${chalk.bold("Account:")}  ${email}`);
    if (me?.id) console.log(`  ${chalk.bold("User id:")}  ${me.id}`);
    console.log("");
    console.log(
      chalk.dim('Run `cgpro status`, then `cgpro ask "..."` — no further login needed.'),
    );
    return 0;
  } finally {
    await session.close();
  }
}

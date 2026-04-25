import chalk from "chalk";
import ora from "ora";
import { openSession } from "../../browser/session.js";
import { goHome, isLoggedIn } from "../../browser/chatgpt.js";
import { SELECTORS, type SelectorSet } from "../../browser/selectors.js";

export interface DoctorOptions {
  profile?: string;
  headed?: boolean;
}

export async function doctorCommand(opts: DoctorOptions): Promise<number> {
  const session = await openSession({ headed: !!opts.headed, profilePath: opts.profile });
  const spinner = ora("Auditing selectors against chatgpt.com…").start();
  let exitCode = 0;
  try {
    await goHome(session.page);
    const logged = await isLoggedIn(session.page, 8_000);
    if (!logged) {
      spinner.warn("Not signed in — running selector audit on the login page.");
    } else {
      spinner.succeed("Signed in. Running selector audit.");
    }

    console.log("");
    console.log(chalk.bold("Selector audit"));
    console.log(chalk.dim("─".repeat(60)));
    const keys = Object.keys(SELECTORS) as Array<keyof SelectorSet>;
    const widthKey = Math.max(...keys.map((k) => k.length)) + 2;
    for (const key of keys) {
      const candidates = SELECTORS[key];
      let firstWorking = -1;
      for (let i = 0; i < candidates.length; i++) {
        try {
          const count = await session.page
            .locator(candidates[i])
            .first()
            .count();
          if (count > 0) {
            firstWorking = i;
            break;
          }
        } catch {
          /* try next */
        }
      }
      const padded = key.toString().padEnd(widthKey);
      if (firstWorking === -1) {
        console.log(`${chalk.red("✖")} ${padded}${chalk.red("no candidate matched")}`);
        exitCode = 5;
      } else if (firstWorking === 0) {
        console.log(`${chalk.green("✔")} ${padded}${chalk.dim(candidates[0])}`);
      } else {
        console.log(
          `${chalk.yellow("⚠")} ${padded}${chalk.yellow(`fallback #${firstWorking}`)} ${chalk.dim(candidates[firstWorking])}`,
        );
      }
    }
    console.log("");
    if (exitCode === 0) {
      console.log(chalk.green("All selectors resolve."));
    } else {
      console.log(
        chalk.yellow(
          "Some selectors failed. File a bug at https://github.com/yannabadie/CGPro4Code/issues",
        ),
      );
    }
    return exitCode;
  } finally {
    await session.close();
  }
}

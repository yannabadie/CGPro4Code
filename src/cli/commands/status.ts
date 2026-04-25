import chalk from "chalk";
import ora from "ora";
import { openSession } from "../../browser/session.js";
import { fetchAuthSession, goHome, isLoggedIn } from "../../browser/chatgpt.js";
import { detectPlan, fetchMe } from "../../api/me.js";
import { fetchModels, findProSlug } from "../../api/models.js";
import { NotLoggedInError } from "../../errors.js";

export interface StatusOptions {
  profile?: string;
}

export async function statusCommand(opts: StatusOptions): Promise<number> {
  const session = await openSession({ headed: false, profilePath: opts.profile });
  const spinner = ora("Checking session…").start();
  try {
    await goHome(session.page);
    if (!(await isLoggedIn(session.page, 8_000))) {
      spinner.fail("Not signed in.");
      throw new NotLoggedInError();
    }
    const auth = await fetchAuthSession(session.page);
    const me = await fetchMe(session.page, auth?.accessToken);
    const models = await fetchModels(session.page, auth?.accessToken);
    spinner.succeed("Session healthy.");

    const email = auth?.user?.email ?? me?.email ?? "(unknown)";
    const plan = detectPlan(me);
    const proSlug = findProSlug(models);
    const expires = auth?.expires ? new Date(auth.expires).toLocaleString() : "(unknown)";

    console.log("");
    console.log(chalk.bold("ChatGPT Pro CLI status"));
    console.log(`  ${chalk.bold("Account:")}      ${email}`);
    console.log(`  ${chalk.bold("Plan:")}         ${plan}`);
    console.log(`  ${chalk.bold("Token until:")} ${expires}`);
    console.log(`  ${chalk.bold("Models:")}       ${models.length} available`);
    if (proSlug) {
      console.log(`  ${chalk.bold("GPT-5.5 Pro:")} ${chalk.green("✓")} (slug: ${proSlug})`);
    } else {
      console.log(`  ${chalk.bold("GPT-5.5 Pro:")} ${chalk.yellow("not detected")}`);
    }
    return 0;
  } finally {
    await session.close();
  }
}

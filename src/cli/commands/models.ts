import chalk from "chalk";
import ora from "ora";
import { openSession } from "../../browser/session.js";
import { fetchAuthSession, goHome, isLoggedIn } from "../../browser/chatgpt.js";
import { fetchModels } from "../../api/models.js";
import { NotLoggedInError } from "../../errors.js";

export interface ModelsOptions {
  profile?: string;
  json?: boolean;
}

export async function modelsCommand(opts: ModelsOptions): Promise<number> {
  const session = await openSession({ headed: false, profilePath: opts.profile });
  const spinner = ora("Fetching models…").start();
  try {
    await goHome(session.page);
    if (!(await isLoggedIn(session.page, 8_000))) {
      spinner.fail("Not signed in.");
      throw new NotLoggedInError();
    }
    const auth = await fetchAuthSession(session.page);
    const models = await fetchModels(session.page, auth?.accessToken);
    spinner.stop();

    if (opts.json) {
      process.stdout.write(JSON.stringify(models, null, 2) + "\n");
      return 0;
    }

    if (models.length === 0) {
      console.log(chalk.yellow("No models returned. Session may be stale — try `cgpro login`."));
      return 0;
    }

    const widthSlug = Math.min(40, Math.max(...models.map((m) => (m.slug ?? "").length)) + 2);
    const widthTitle = Math.min(40, Math.max(...models.map((m) => (m.title ?? "").length)) + 2);

    console.log("");
    console.log(chalk.bold("Available models:"));
    console.log(
      chalk.dim("  ") +
        chalk.bold("slug".padEnd(widthSlug)) +
        chalk.bold("title".padEnd(widthTitle)) +
        chalk.bold("vis"),
    );
    for (const m of models) {
      const visible = (m.visibility ?? "").toLowerCase() === "list";
      const dot = visible ? chalk.green("●") : chalk.dim("○");
      console.log(
        `  ${dot} ${(m.slug ?? "").padEnd(widthSlug)}${(m.title ?? "").padEnd(widthTitle)}${m.visibility ?? ""}`,
      );
    }
    console.log("");
    console.log(chalk.dim(`${models.length} model(s) — green = selectable in picker.`));
    return 0;
  } finally {
    await session.close();
  }
}

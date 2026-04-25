#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { VERSION } from "../version.js";
import { CgproError } from "../errors.js";
import { loginCommand } from "./commands/login.js";

const program = new Command();

program
  .name("cgpro")
  .description(
    "ChatGPT Pro from your terminal — drives a real Chrome session against chatgpt.com.",
  )
  .version(VERSION, "-v, --version");

program
  .command("login")
  .description("Open Chrome and sign in to your ChatGPT account (one-time setup).")
  .option("--profile <path>", "override the default profile directory")
  .option("--timeout <seconds>", "max wait for sign-in", (v) => parseInt(v, 10), 300)
  .action(async (opts) => {
    const code = await runOrExit(() => loginCommand(opts));
    process.exit(code);
  });

program.action(() => {
  program.help();
});

async function runOrExit(fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (err instanceof CgproError) {
      console.error(chalk.red(`✖ ${err.message}`));
      if (err.hint) console.error(chalk.dim(`  ${err.hint}`));
      return err.exitCode;
    }
    console.error(chalk.red("✖ Unexpected error:"), err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) {
      console.error(chalk.dim(err.stack));
    }
    return 1;
  }
}

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red("✖"), err instanceof Error ? err.message : err);
  process.exit(1);
});

#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { VERSION } from "../version.js";
import { CgproError } from "../errors.js";
import { loginCommand } from "./commands/login.js";
import { statusCommand } from "./commands/status.js";
import { modelsCommand } from "./commands/models.js";
import { askCommand } from "./commands/ask.js";

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

program
  .command("status")
  .description("Show current session health, plan, and model availability.")
  .option("--profile <path>", "override the default profile directory")
  .action(async (opts) => {
    const code = await runOrExit(() => statusCommand(opts));
    process.exit(code);
  });

program
  .command("models")
  .description("List models available to the current account.")
  .option("--profile <path>", "override the default profile directory")
  .option("--json", "emit JSON instead of a table", false)
  .action(async (opts) => {
    const code = await runOrExit(() => modelsCommand(opts));
    process.exit(code);
  });

program
  .command("ask")
  .description("Send a single prompt to ChatGPT and stream the response.")
  .argument("[prompt...]", "your prompt (also reads piped stdin)")
  .option("-m, --model <slug>", "model slug (default: GPT-5.5 Pro)")
  .option("--web", "enable live web search (default)")
  .option("--no-web", "disable live web search")
  .option("--headed", "show the browser window")
  .option("--headless", "force headless mode")
  .option("--profile <path>", "override the default profile directory")
  .option("-i, --image <path>", "attach an image (repeatable)", (v: string, prev: string[] = []) => [...prev, v])
  .option("--resume <name|id>", "resume an existing conversation")
  .option("--save <name>", "save the resulting conversation under a name")
  .option("--timeout <seconds>", "max wait per turn", (v) => parseInt(v, 10))
  .option("--json", "emit NDJSON events instead of human output")
  .option("--no-stream", "buffer until done, then print")
  .option("--render", "render markdown after the stream completes")
  .action(async (promptParts: string[], opts) => {
    const promptArg = (promptParts ?? []).join(" ").trim();
    const code = await runOrExit(() => askCommand(promptArg, opts));
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

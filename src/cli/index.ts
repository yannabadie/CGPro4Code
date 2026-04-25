#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { VERSION } from "../version.js";
import { CgproError } from "../errors.js";
import { loginCommand } from "./commands/login.js";
import { adoptCommand } from "./commands/adopt.js";
import { statusCommand } from "./commands/status.js";
import { modelsCommand } from "./commands/models.js";
import { askCommand } from "./commands/ask.js";
import { chatCommand } from "./commands/chat.js";
import { doctorCommand } from "./commands/doctor.js";
import { logoutCommand } from "./commands/logout.js";
import {
  listThreadsCmd,
  removeThreadCmd,
  renameThreadCmd,
  saveThreadCmd,
  showThreadCmd,
} from "./commands/thread.js";

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
  .command("adopt")
  .description(
    "Import the local ChatGPT desktop app's session into the cgpro profile (recommended).",
  )
  .option("--profile <path>", "override the default profile directory")
  .option("--kill-app", "force-close the ChatGPT app if it's running")
  .action(async (opts) => {
    const code = await runOrExit(() => adoptCommand(opts));
    process.exit(code);
  });

program
  .command("status")
  .description("Show current session health, plan, and model availability.")
  .option("--profile <path>", "override the default profile directory")
  .option("--headless", "run headless (faster but fingerprint may be challenged)")
  .action(async (opts) => {
    const code = await runOrExit(() => statusCommand(opts));
    process.exit(code);
  });

program
  .command("models")
  .description("List models available to the current account.")
  .option("--profile <path>", "override the default profile directory")
  .option("--headless", "run headless")
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
  .option("--background", "open the browser off-screen so it never pops up in front")
  .option("--new-session", "start a fresh conversation (do not auto-resume the recent shell session)")
  .action(async (promptParts: string[], opts) => {
    const promptArg = (promptParts ?? []).join(" ").trim();
    const code = await runOrExit(() => askCommand(promptArg, opts));
    process.exit(code);
  });

program
  .command("doctor")
  .description("Audit selectors against the live chatgpt.com DOM.")
  .option("--headed", "show the browser window")
  .option("--profile <path>", "override the default profile directory")
  .action(async (opts) => {
    const code = await runOrExit(() => doctorCommand(opts));
    process.exit(code);
  });

program
  .command("logout")
  .description("Remove the local browser profile (forces a re-login next run).")
  .option("--profile <path>", "override the default profile directory")
  .option("--yes", "skip confirmation")
  .action(async (opts) => {
    const code = await runOrExit(() => logoutCommand(opts));
    process.exit(code);
  });

program
  .command("chat")
  .description("Interactive REPL: multi-turn conversation with one open browser page.")
  .option("-m, --model <slug>", "model slug (default: GPT-5.5 Pro)")
  .option("--web", "enable web search (default)")
  .option("--no-web", "disable web search")
  .option("--headed", "show the browser window")
  .option("--headless", "force headless mode")
  .option("--profile <path>", "override the default profile directory")
  .option("--resume <name|id>", "resume an existing conversation")
  .option("--timeout <seconds>", "max wait per turn", (v) => parseInt(v, 10))
  .option("--render", "render markdown after each completed turn")
  .action(async (opts) => {
    const code = await runOrExit(() => chatCommand(opts));
    process.exit(code);
  });

const thread = program.command("thread").description("Manage saved conversations.");

thread
  .command("list")
  .description("List saved threads.")
  .option("--json", "emit JSON")
  .action(async (opts) => {
    const code = await runOrExit(async () => listThreadsCmd(opts));
    process.exit(code);
  });

thread
  .command("show <name>")
  .description("Show details of a saved thread.")
  .option("--json", "emit JSON")
  .action(async (name: string, opts) => {
    const code = await runOrExit(async () => showThreadCmd(name, opts));
    process.exit(code);
  });

thread
  .command("rm <name>")
  .description("Remove a saved thread (the chatgpt.com conversation is not deleted).")
  .action(async (name: string) => {
    const code = await runOrExit(async () => removeThreadCmd(name));
    process.exit(code);
  });

thread
  .command("rename <old> <new>")
  .description("Rename a saved thread.")
  .action(async (oldName: string, newName: string) => {
    const code = await runOrExit(async () => renameThreadCmd(oldName, newName));
    process.exit(code);
  });

thread
  .command("save <id> <name>")
  .description("Save an existing chatgpt.com conversation UUID under a name.")
  .action(async (id: string, name: string) => {
    const code = await runOrExit(() => saveThreadCmd(id, name));
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

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
  daemonServerCmd,
  daemonStartCmd,
  daemonStatusCmd,
  daemonStopCmd,
} from "./commands/daemon.js";
import {
  listThreadsCmd,
  removeThreadCmd,
  renameThreadCmd,
  saveThreadCmd,
  showThreadCmd,
  syncThreadsCmd,
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
  .option("--web", "live web search (always on; flag kept for compatibility)")
  .option("--no-web", "deprecated — web search is policy-on, this flag is ignored")
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
  .option("--no-daemon", "force a cold-start browser even if a daemon is running")
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
  .option("--web", "live web search (always on; flag kept for compatibility)")
  .option("--no-web", "deprecated — web search is policy-on, this flag is ignored")
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
  .description("List saved threads (or `--remote` for the chatgpt.com sidebar).")
  .option("--json", "emit JSON")
  .option("--remote", "list the chatgpt.com conversation history (cached)")
  .option("--refresh", "with --remote: refresh the cache from chatgpt.com first")
  .option("--limit <n>", "with --refresh: max rows to fetch", (v) => parseInt(v, 10))
  .option("--profile <path>", "override the default profile directory")
  .option("--headless", "force headless when refreshing")
  .action(async (opts) => {
    const code = await runOrExit(() => listThreadsCmd(opts));
    process.exit(code);
  });

thread
  .command("sync")
  .description("Pull the chatgpt.com conversation list into the local cache.")
  .option("--json", "emit JSON")
  .option("--limit <n>", "max rows to fetch (default 100)", (v) => parseInt(v, 10))
  .option("--profile <path>", "override the default profile directory")
  .option("--headless", "force headless mode")
  .action(async (opts) => {
    const code = await runOrExit(() => syncThreadsCmd(opts));
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

const daemon = program
  .command("daemon")
  .description("Long-lived browser process so `ask` doesn't pay cold-start cost.");

daemon
  .command("start")
  .description("Spawn the daemon (idempotent — exits 0 if already running).")
  .option("--profile <path>", "override the default profile directory")
  .option("--no-background", "open the daemon's browser window in front")
  .action(async (opts) => {
    const code = await runOrExit(() => daemonStartCmd(opts));
    process.exit(code);
  });

daemon
  .command("stop")
  .description("Stop the running daemon.")
  .action(async () => {
    const code = await runOrExit(() => daemonStopCmd());
    process.exit(code);
  });

daemon
  .command("status")
  .description("Show daemon state.")
  .option("--json", "emit JSON")
  .action(async (opts) => {
    const code = await runOrExit(() => daemonStatusCmd(opts));
    process.exit(code);
  });

// Hidden — only invoked by `daemon start` after spawning a child.
program
  .command("daemon-server", { hidden: true })
  .option("--profile <path>")
  .option("--no-background")
  .action(async (opts) => {
    // Never exits; runDaemonServer keeps the loop alive.
    await daemonServerCmd(opts);
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

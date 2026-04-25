import chalk from "chalk";
import ora from "ora";
import { runAsk, type AskOptions } from "../../core/orchestrator.js";
import { renderMarkdown } from "../../core/render/markdown.js";
import { saveThread } from "../../store/threads.js";
import { loadConfig } from "../../store/config.js";

export interface AskCliOptions {
  model?: string;
  web?: boolean;
  noWeb?: boolean;
  headed?: boolean;
  headless?: boolean;
  profile?: string;
  image?: string[];
  resume?: string;
  save?: string;
  timeout?: number;
  json?: boolean;
  noStream?: boolean;
  render?: boolean;
}

export async function askCommand(promptArg: string, opts: AskCliOptions): Promise<number> {
  const cfg = loadConfig();
  const stdinText = await readStdinIfPiped();
  const prompt = [promptArg, stdinText].filter(Boolean).join("\n\n").trim();
  if (!prompt) {
    console.error(chalk.red("✖ No prompt provided. Pass a string or pipe stdin."));
    return 1;
  }

  const web = opts.noWeb ? false : opts.web ?? cfg.defaultWeb;
  const headless = opts.headed ? false : opts.headless ?? cfg.defaultHeadless;
  const conversationId = opts.resume ? resolveConvId(opts.resume) : undefined;

  const askOpts: AskOptions = {
    prompt,
    model: opts.model ?? cfg.defaultModel,
    web,
    images: opts.image ?? [],
    conversationId,
    timeoutSec: opts.timeout ?? cfg.timeoutSec,
    headless,
    profile: opts.profile,
  };

  if (opts.json) {
    return runJsonMode(askOpts, opts);
  }

  return runHumanMode(askOpts, opts);
}

async function runHumanMode(askOpts: AskOptions, opts: AskCliOptions): Promise<number> {
  const spinner = ora({ text: "Thinking…", color: "cyan" }).start();
  const runner = runAsk(askOpts);

  let firstDelta = true;
  let buffer = "";

  const writeStream = !opts.noStream && !opts.render;

  try {
    for await (const ev of runner.events) {
      if (ev.type === "started") {
        spinner.text = "Streaming…";
      } else if (ev.type === "delta") {
        if (firstDelta) {
          spinner.stop();
          firstDelta = false;
        }
        buffer += ev.text;
        if (writeStream) {
          process.stdout.write(ev.text);
        }
      } else if (ev.type === "tool") {
        // future: render tool calls
      } else if (ev.type === "error") {
        if (!firstDelta) process.stdout.write("\n");
        spinner.fail(ev.message);
        return 1;
      } else if (ev.type === "done") {
        if (!firstDelta && writeStream) process.stdout.write("\n");
        if (opts.render || opts.noStream) {
          spinner.stop();
          const text = ev.finalText ?? buffer;
          process.stdout.write(renderMarkdown(text) + "\n");
        }
        if (firstDelta) spinner.stop();
      }
    }

    const summary = await runner.result;
    if (opts.save && summary.conversationId) {
      await saveThread(opts.save, summary.conversationId, askOpts.model);
      console.log(chalk.dim(`\nSaved conversation as "${opts.save}".`));
    }
    return 0;
  } catch (err) {
    spinner.stop();
    throw err;
  }
}

async function runJsonMode(askOpts: AskOptions, opts: AskCliOptions): Promise<number> {
  const runner = runAsk(askOpts);
  try {
    for await (const ev of runner.events) {
      process.stdout.write(JSON.stringify(ev) + "\n");
    }
    const summary = await runner.result;
    if (opts.save && summary.conversationId) {
      await saveThread(opts.save, summary.conversationId, askOpts.model);
    }
    return 0;
  } catch {
    return 1;
  }
}

function readStdinIfPiped(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
  });
}

function resolveConvId(nameOrId: string): string {
  // Threads helper resolves names → ids; if it's already a UUID, pass through.
  if (/^[0-9a-f-]{36}$/i.test(nameOrId)) return nameOrId;
  // Lazy require to avoid circulars.
  // The caller should pre-resolve via threads.find — kept simple for now.
  return nameOrId;
}

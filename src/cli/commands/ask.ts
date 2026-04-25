import chalk from "chalk";
import ora from "ora";
import { runAsk, type AskOptions } from "../../core/orchestrator.js";
import { renderMarkdown } from "../../core/render/markdown.js";
import { findThread, saveThread } from "../../store/threads.js";
import { loadConfig } from "../../store/config.js";
import {
  clearActiveConversation,
  getActiveConversationId,
  saveActiveConversationId,
} from "../../store/session.js";

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
  /** Skip auto-resume — start a brand-new conversation. */
  newSession?: boolean;
  /** Hide the browser window off-screen. */
  background?: boolean;
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
  // Conversation resolution priority:
  //   1. --new-session wipes any ambient session and starts fresh
  //   2. explicit --resume <name|id> wins
  //   3. otherwise auto-resume the recent persistent session if any.
  if (opts.newSession) {
    clearActiveConversation();
  }
  let conversationId: string | undefined;
  if (opts.resume) {
    conversationId = resolveConvId(opts.resume);
  } else if (!opts.newSession) {
    const sess = getActiveConversationId();
    if (sess) conversationId = sess;
  }

  const askOpts: AskOptions = {
    prompt,
    model: opts.model ?? cfg.defaultModel,
    web,
    images: opts.image ?? [],
    conversationId,
    timeoutSec: opts.timeout ?? cfg.timeoutSec,
    headless,
    background: opts.background,
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
        spinner.stop();
        const text = ev.finalText ?? buffer;
        // Emit the final answer when:
        //  - no deltas were ever printed (SSE interceptor missed the URL,
        //    DOM gave us the full text in one go), or
        //  - the user explicitly asked for buffered/rendered output.
        const needsEmit = firstDelta || opts.render || opts.noStream;
        if (needsEmit && text.length > 0) {
          if (opts.render || opts.noStream) {
            process.stdout.write(renderMarkdown(text) + "\n");
          } else {
            process.stdout.write(text + "\n");
          }
        } else if (!firstDelta && writeStream) {
          process.stdout.write("\n");
        }
      }
    }

    const summary = await runner.result;
    if (summary.conversationId) {
      // Auto-thread so the next ask in this Claude Code session continues here.
      saveActiveConversationId(summary.conversationId);
    }
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
    if (summary.conversationId) {
      saveActiveConversationId(summary.conversationId);
    }
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
  if (/^[0-9a-f-]{36}$/i.test(nameOrId)) return nameOrId;
  const t = findThread(nameOrId);
  if (t) return t.id;
  return nameOrId;
}

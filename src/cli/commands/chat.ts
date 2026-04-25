import chalk from "chalk";
import ora from "ora";
import prompts from "prompts";
import { openSession, type Session } from "../../browser/session.js";
import { fetchAuthSession, goHome, isLoggedIn } from "../../browser/chatgpt.js";
import {
  currentConversationId,
  openConversation,
  readLatestAssistantText,
  sendPrompt,
  setWebSearch,
  waitTurnComplete,
} from "../../browser/conversation.js";
import { fetchModels, findProSlug } from "../../api/models.js";
import { setActiveEmitter, StreamEmitter } from "../../core/stream.js";
import { findThread, saveThread } from "../../store/threads.js";
import { loadConfig } from "../../store/config.js";
import { NotLoggedInError, TurnTimeoutError } from "../../errors.js";
import { renderMarkdown } from "../../core/render/markdown.js";
import { assertNoDaemon } from "../../daemon/client.js";

export interface ChatCliOptions {
  model?: string;
  web?: boolean;
  noWeb?: boolean;
  headed?: boolean;
  headless?: boolean;
  profile?: string;
  resume?: string;
  timeout?: number;
  render?: boolean;
}

export async function chatCommand(opts: ChatCliOptions): Promise<number> {
  // Chat keeps a persistent BrowserContext across many turns; routing
  // it through the daemon would require a streaming multi-turn API
  // that the daemon doesn't expose yet. Until then, refuse cleanly.
  await assertNoDaemon("chat");
  const cfg = loadConfig();
  const headless = opts.headed ? false : opts.headless ?? cfg.defaultHeadless;
  // Web search is locked ON for chat — same policy as `ask`.
  if (opts.noWeb || opts.web === false) {
    console.error(chalk.dim("(--no-web ignored — web search is policy-on)"));
  }
  let webEnabled = cfg.defaultWeb !== false;
  const timeoutSec = opts.timeout ?? cfg.timeoutSec;

  const session: Session = await openSession({ headed: !headless, profilePath: opts.profile });
  const page = session.page;
  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    await session.close().catch(() => {});
  };
  process.on("SIGINT", () => {
    void cleanup().then(() => process.exit(130));
  });

  try {
    await goHome(page);
    if (!(await isLoggedIn(page, 10_000))) {
      throw new NotLoggedInError();
    }

    let modelSlug = opts.model;
    if (!modelSlug || /5[._-]?5[._-]?pro|gpt-5-pro|^pro$/i.test(modelSlug)) {
      const auth = await fetchAuthSession(page);
      const models = await fetchModels(page, auth?.accessToken);
      const pro = findProSlug(models);
      modelSlug = pro ?? modelSlug ?? "gpt-5-pro";
    }

    const resumeId = opts.resume ? resolveConvId(opts.resume) : undefined;

    await openConversation(page, { model: modelSlug, conversationId: resumeId });
    await setWebSearch(page, webEnabled);

    console.log(
      chalk.bold(`cgpro chat`) +
        chalk.dim(` — model: ${modelSlug}, web: ${webEnabled ? "on" : "off"}`),
    );
    console.log(
      chalk.dim(
        "Slash: :web on/off, :model <slug>, :reset, :save <name>, :thread, :quit (Ctrl+C).\n" +
          "Multi-line: end the line with a single backslash \\ to continue on the next line.",
      ),
    );
    console.log("");

    let turnCount = 0;

    while (true) {
      const userText = await readMultiLine();
      if (userText === null) break;
      if (!userText) continue;

      if (userText.startsWith(":")) {
        const handled = await handleSlash(userText, {
          page,
          setWeb: async (on) => {
            webEnabled = on;
            await setWebSearch(page, on);
          },
          setModel: async (slug) => {
            modelSlug = slug;
            await openConversation(page, { model: slug });
            await setWebSearch(page, webEnabled);
          },
          reset: async () => {
            await openConversation(page, { model: modelSlug });
            await setWebSearch(page, webEnabled);
          },
          conversationId: () => currentConversationId(page),
          getModel: () => modelSlug ?? "?",
          getWeb: () => webEnabled,
        });
        if (handled === "quit") break;
        continue;
      }

      turnCount++;

      // Fresh emitter for this turn — the binding routes its events here.
      const emitter = new StreamEmitter();
      setActiveEmitter(session.context, emitter);

      const spinner = ora({ text: "Thinking…", color: "cyan" }).start();
      let firstDelta = true;
      let buffer = "";

      const drainPromise = (async () => {
        for await (const ev of emitter) {
          if (ev.type === "delta") {
            if (firstDelta) {
              spinner.stop();
              firstDelta = false;
              process.stdout.write(chalk.green("gpt ▸ "));
            }
            buffer += ev.text;
            if (!opts.render) process.stdout.write(ev.text);
          } else if (ev.type === "error") {
            spinner.fail(ev.message);
            return;
          } else if (ev.type === "done") {
            if (!firstDelta && !opts.render) process.stdout.write("\n");
            if (opts.render) {
              const final = ev.finalText ?? buffer;
              spinner.stop();
              process.stdout.write(renderMarkdown(final) + "\n");
            }
            if (firstDelta) spinner.stop();
            return;
          }
        }
      })();

      await sendPrompt(page, userText);
      await waitTurnComplete(page, timeoutSec * 1_000).catch(() => {
        spinner.fail(`Turn timed out after ${timeoutSec}s.`);
        emitter.push({
          type: "error",
          message: new TurnTimeoutError(timeoutSec).message,
        });
      });

      // Synthesize a `done` from the DOM if the SSE stream didn't end.
      if (!emitter.isFinished()) {
        const dom = await readLatestAssistantText(page);
        emitter.push({ type: "done", finalText: dom });
      }
      await drainPromise;

      console.log("");
    }

    console.log(chalk.dim(`Exited after ${turnCount} turn(s).`));
    return 0;
  } finally {
    await cleanup();
  }
}

/**
 * Reads a single user prompt. To enter multiple lines, end any line with a
 * trailing backslash `\` — `prompts` is single-line so this is the smoothest
 * cross-platform way without bringing in a full terminal line editor.
 *
 * Returns null on Ctrl+C / Ctrl+D.
 */
async function readMultiLine(): Promise<string | null> {
  const lines: string[] = [];
  while (true) {
    let value: string | undefined;
    let cancelled = false;
    const response = await prompts(
      {
        type: "text",
        name: "value",
        message: chalk.cyan(lines.length === 0 ? "you ▸" : "    ▸"),
      },
      {
        onCancel: () => {
          cancelled = true;
        },
      },
    );
    if (cancelled) return null;
    value = response.value as string | undefined;
    if (value === undefined) return null;
    if (value.endsWith("\\")) {
      lines.push(value.slice(0, -1));
      continue;
    }
    lines.push(value);
    return lines.join("\n").trim();
  }
}

interface SlashContext {
  page: import("patchright").Page;
  setWeb: (on: boolean) => Promise<void>;
  setModel: (slug: string) => Promise<void>;
  reset: () => Promise<void>;
  conversationId: () => string | null;
  getModel: () => string;
  getWeb: () => boolean;
}

async function handleSlash(line: string, ctx: SlashContext): Promise<"quit" | "ok"> {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  switch (cmd) {
    case "quit":
    case "q":
    case "exit":
      return "quit";
    case "web": {
      const v = rest[0]?.toLowerCase();
      if (v === "on" || v === "true" || v === "1") {
        await ctx.setWeb(true);
        console.log(chalk.dim("web search: on"));
      } else if (v === "off" || v === "false" || v === "0") {
        await ctx.setWeb(false);
        console.log(chalk.dim("web search: off"));
      } else {
        console.log(chalk.dim(`web search: ${ctx.getWeb() ? "on" : "off"}`));
      }
      return "ok";
    }
    case "model": {
      if (rest[0]) {
        await ctx.setModel(rest[0]);
        console.log(chalk.dim(`model: ${rest[0]} (new conversation started)`));
      } else {
        console.log(chalk.dim(`model: ${ctx.getModel()}`));
      }
      return "ok";
    }
    case "reset":
      await ctx.reset();
      console.log(chalk.dim("started a fresh conversation"));
      return "ok";
    case "save": {
      const id = ctx.conversationId();
      if (!id) {
        console.log(chalk.yellow("no conversation id yet — send a prompt first"));
        return "ok";
      }
      const name = rest[0];
      if (!name) {
        console.log(chalk.yellow("usage: :save <name>"));
        return "ok";
      }
      await saveThread(name, id, ctx.getModel());
      console.log(chalk.green(`saved as "${name}"`));
      return "ok";
    }
    case "thread": {
      const id = ctx.conversationId();
      console.log(chalk.dim(id ? `conversation: ${id}` : "no conversation id yet"));
      return "ok";
    }
    case "help":
      console.log(
        chalk.dim("Commands: :web on/off, :model <slug>, :reset, :save <name>, :thread, :quit"),
      );
      return "ok";
    default:
      console.log(chalk.yellow(`unknown command: :${cmd}`));
      return "ok";
  }
}

function resolveConvId(nameOrId: string): string {
  if (/^[0-9a-f-]{36}$/i.test(nameOrId)) return nameOrId;
  const t = findThread(nameOrId);
  return t?.id ?? nameOrId;
}

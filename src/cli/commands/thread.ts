import chalk from "chalk";
import ora from "ora";
import {
  findThread,
  listThreads,
  removeThread,
  renameThread,
  saveThread,
} from "../../store/threads.js";
import {
  readConversationsCache,
  writeConversationsCache,
} from "../../store/conversations-cache.js";
import { fetchRemoteConversations } from "../../api/conversations.js";
import { openSession } from "../../browser/session.js";
import { goHome, isLoggedIn } from "../../browser/chatgpt.js";
import { NotLoggedInError } from "../../errors.js";
import { assertNoDaemon } from "../../daemon/client.js";

export interface ListThreadsOptions {
  json?: boolean;
  /** Show the chatgpt.com remote list instead of local saved bookmarks. */
  remote?: boolean;
  /** With --remote: refresh the cache by talking to chatgpt.com first. */
  refresh?: boolean;
  /** With --remote+--refresh: max rows to fetch. */
  limit?: number;
  profile?: string;
  headless?: boolean;
}

export async function listThreadsCmd(opts: ListThreadsOptions): Promise<number> {
  if (opts.remote) {
    return await listRemoteCmd(opts);
  }
  const threads = listThreads();
  if (opts.json) {
    process.stdout.write(JSON.stringify(threads, null, 2) + "\n");
    return 0;
  }
  if (threads.length === 0) {
    console.log(chalk.dim("(no saved threads)"));
    console.log(chalk.dim("Save one with `cgpro ask --save <name> \"...\"`."));
    return 0;
  }
  const widthName = Math.min(30, Math.max(...threads.map((t) => t.name.length)) + 2);
  console.log(chalk.bold("Saved threads:"));
  console.log(
    chalk.dim("  ") + chalk.bold("name".padEnd(widthName)) + chalk.bold("model".padEnd(18)) + chalk.bold("id"),
  );
  for (const t of threads) {
    console.log(`  ${t.name.padEnd(widthName)}${(t.model ?? "—").padEnd(18)}${t.id}`);
  }
  return 0;
}

async function listRemoteCmd(opts: ListThreadsOptions): Promise<number> {
  if (opts.refresh) {
    const code = await syncThreadsCmd({
      profile: opts.profile,
      headless: opts.headless,
      limit: opts.limit,
      json: false,
    });
    if (code !== 0) return code;
  }
  const cache = readConversationsCache();
  if (!cache) {
    console.log(chalk.dim("(no remote cache yet)"));
    console.log(chalk.dim("Run `cgpro thread sync` to populate it."));
    return 0;
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(cache, null, 2) + "\n");
    return 0;
  }
  console.log(
    chalk.bold(`Remote conversations`) +
      chalk.dim(` (cached ${cache.fetchedAt}, ${cache.count} rows)`),
  );
  for (const c of cache.conversations) {
    const date = c.updatedAt ? c.updatedAt.slice(0, 10) : "          ";
    const archived = c.isArchived ? chalk.dim(" [archived]") : "";
    console.log(`  ${chalk.dim(date)}  ${c.id}  ${c.title}${archived}`);
  }
  return 0;
}

export interface SyncThreadsOptions {
  profile?: string;
  headless?: boolean;
  limit?: number;
  json?: boolean;
}

export async function syncThreadsCmd(opts: SyncThreadsOptions): Promise<number> {
  await assertNoDaemon("thread sync");
  const session = await openSession({
    headed: !opts.headless,
    profilePath: opts.profile,
    background: true,
  });
  const spinner = ora("Loading chatgpt.com…").start();
  try {
    await goHome(session.page);
    if (!(await isLoggedIn(session.page, 8_000))) {
      spinner.fail("Not signed in.");
      throw new NotLoggedInError();
    }
    spinner.text = "Fetching conversations…";
    const conversations = await fetchRemoteConversations(session.page, {
      limit: opts.limit ?? 100,
    });
    writeConversationsCache(conversations);
    const sourceCounts = conversations.reduce<Record<string, number>>((acc, c) => {
      acc[c.source] = (acc[c.source] ?? 0) + 1;
      return acc;
    }, {});
    const sourceNote = Object.entries(sourceCounts)
      .map(([k, v]) => `${v} via ${k}`)
      .join(", ");
    spinner.succeed(
      `Synced ${conversations.length} conversation${conversations.length === 1 ? "" : "s"}` +
        (sourceNote ? chalk.dim(` (${sourceNote})`) : ""),
    );
    if (opts.json) {
      process.stdout.write(JSON.stringify(conversations, null, 2) + "\n");
    } else if (conversations.length === 0) {
      console.log(
        chalk.yellow(
          "Sidebar appears empty. If you can see chats in the chatgpt.com UI,\n" +
            "set CGPRO_DEBUG=1 and re-run to see which selectors / endpoints failed.",
        ),
      );
    }
    return 0;
  } finally {
    await session.close();
  }
}

export function showThreadCmd(nameOrId: string, opts: { json?: boolean }): number {
  const t = findThread(nameOrId);
  if (!t) {
    console.error(chalk.red(`✖ No thread named "${nameOrId}".`));
    return 1;
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(t, null, 2) + "\n");
    return 0;
  }
  console.log(chalk.bold(t.name));
  console.log(`  id:         ${t.id}`);
  console.log(`  model:      ${t.model ?? "—"}`);
  console.log(`  title:      ${t.title ?? "—"}`);
  console.log(`  created:    ${t.created_at}`);
  console.log(`  updated:    ${t.updated_at}`);
  console.log(`  url:        https://chatgpt.com/c/${t.id}`);
  return 0;
}

export function removeThreadCmd(nameOrId: string): number {
  const removed = removeThread(nameOrId);
  if (!removed) {
    console.error(chalk.red(`✖ No thread named "${nameOrId}".`));
    return 1;
  }
  console.log(chalk.green(`✓ Removed thread "${nameOrId}".`));
  return 0;
}

export function renameThreadCmd(oldName: string, newName: string): number {
  try {
    const t = renameThread(oldName, newName);
    if (!t) {
      console.error(chalk.red(`✖ No thread named "${oldName}".`));
      return 1;
    }
    console.log(chalk.green(`✓ Renamed "${oldName}" → "${newName}".`));
    return 0;
  } catch (err) {
    console.error(chalk.red(`✖ ${(err as Error).message}`));
    return 1;
  }
}

export async function saveThreadCmd(id: string, name: string): Promise<number> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    console.error(chalk.red(`✖ "${id}" is not a chatgpt.com conversation UUID.`));
    return 1;
  }
  await saveThread(name, id);
  console.log(chalk.green(`✓ Saved conversation "${id}" as "${name}".`));
  return 0;
}

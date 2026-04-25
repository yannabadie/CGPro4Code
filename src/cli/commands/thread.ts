import chalk from "chalk";
import {
  findThread,
  listThreads,
  removeThread,
  renameThread,
  saveThread,
} from "../../store/threads.js";

export function listThreadsCmd(opts: { json?: boolean }): number {
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

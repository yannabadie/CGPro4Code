/**
 * `cgpro project list | show | link | unlink | create | digest`
 *
 * Mirrors the cwd → ChatGPT Project relationship so conversations
 * started from this directory land inside the corresponding gizmo
 * (and out of your "Recents" list).
 */

import chalk from "chalk";
import ora from "ora";
import { openSession } from "../../browser/session.js";
import { goHome } from "../../browser/chatgpt.js";
import {
  listProjects,
  listProjectConversations,
  type Project,
} from "../../api/projects.js";
import {
  appendProjectMemory,
  findMappingByGizmoId,
  findMappingByKey,
  listMappings,
  readProjectMemory,
  removeMapping,
  resolveLocalProject,
  upsertMapping,
  type ProjectMapping,
} from "../../store/projects.js";
import { findThread } from "../../store/threads.js";
import { runAsk } from "../../core/orchestrator.js";
import { assertNoDaemon } from "../../daemon/client.js";
import { NotLoggedInError } from "../../errors.js";
import { isLoggedIn } from "../../browser/chatgpt.js";

export interface ProjectCmdOpts {
  profile?: string;
  headless?: boolean;
  json?: boolean;
}

export async function projectListCmd(opts: ProjectCmdOpts): Promise<number> {
  await assertNoDaemon("project list");
  const session = await openSession({
    headed: !opts.headless,
    profilePath: opts.profile,
    background: true,
  });
  const spinner = ora("Loading projects from chatgpt.com…").start();
  try {
    await goHome(session.page);
    if (!(await isLoggedIn(session.page, 8_000))) {
      spinner.fail("Not signed in.");
      throw new NotLoggedInError();
    }
    const remote = await listProjects(session.page);
    const local = listMappings();
    spinner.succeed(`${remote.length} project(s) on chatgpt.com, ${local.length} linked locally.`);

    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ remote, local, currentCwd: resolveLocalProject() }, null, 2) + "\n",
      );
      return 0;
    }

    const here = resolveLocalProject();
    const linkedHere = findMappingByKey(here.key);
    console.log("");
    console.log(chalk.bold("Current cwd:"));
    console.log(`  ${chalk.dim(`(${here.source})`)} ${here.key}`);
    if (linkedHere) {
      console.log(
        `  ${chalk.green("→ linked")} to ${chalk.bold(linkedHere.name)} (${linkedHere.gizmoId})`,
      );
    } else {
      console.log(`  ${chalk.yellow("not linked")} — \`cgpro project link <name>\` or \`cgpro project create\``);
    }
    console.log("");
    console.log(chalk.bold("Remote projects:"));
    if (remote.length === 0) {
      console.log(chalk.dim("  (none)"));
    } else {
      const widthName = Math.min(40, Math.max(...remote.map((p) => p.name.length)) + 2);
      for (const p of remote) {
        const linked = local.find((m) => m.gizmoId === p.id);
        const tag = linked ? chalk.green(`linked: ${shortenKey(linked.key)}`) : chalk.dim("(unlinked)");
        console.log(`  ${p.name.padEnd(widthName)}${chalk.dim(p.id.slice(0, 16) + "…")}  ${tag}`);
      }
    }
    return 0;
  } finally {
    await session.close();
  }
}

export async function projectShowCmd(
  nameOrId: string | undefined,
  opts: ProjectCmdOpts,
): Promise<number> {
  await assertNoDaemon("project show");
  const session = await openSession({
    headed: !opts.headless,
    profilePath: opts.profile,
    background: true,
  });
  try {
    await goHome(session.page);
    if (!(await isLoggedIn(session.page, 8_000))) throw new NotLoggedInError();
    const remote = await listProjects(session.page);
    const target =
      nameOrId === undefined
        ? findMappingByKey(resolveLocalProject().key)
        : findMappingForLookup(nameOrId, remote);
    if (!target) {
      console.error(chalk.red("✖ Project not found (locally or remotely)."));
      return 1;
    }
    const id = "gizmoId" in target ? target.gizmoId : target.id;
    const project = remote.find((p) => p.id === id) ?? null;
    const memory = readProjectMemory(id);
    const conversations = await listProjectConversations(session.page, id, "0", 20);
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ project, mapping: findMappingByGizmoId(id), conversations, memoryChars: memory.length }, null, 2) + "\n",
      );
      return 0;
    }
    console.log(chalk.bold(project?.name ?? id));
    console.log(`  id:           ${id}`);
    if (project?.shortUrl) console.log(`  short-url:    /g/${project.shortUrl}/project`);
    if (project?.description) console.log(`  description:  ${project.description}`);
    const mapping = findMappingByGizmoId(id);
    if (mapping) {
      console.log(`  linked to:    ${mapping.key}`);
      console.log(`  linked at:    ${mapping.linkedAt}`);
    }
    console.log(`  memory:       ${memory.length} chars (${memoryFilePathHint(id)})`);
    console.log("");
    console.log(chalk.bold(`Recent conversations (${conversations.length}):`));
    for (const c of conversations) {
      const date = c.updatedAt ? c.updatedAt.slice(0, 10) : "          ";
      console.log(`  ${chalk.dim(date)}  ${c.id}  ${c.title}`);
    }
    return 0;
  } finally {
    await session.close();
  }
}

function findMappingForLookup(
  nameOrId: string,
  remote: Project[],
): ProjectMapping | Project | null {
  // Local mappings first (by name or by key contains)
  const local = listMappings().find(
    (m) => m.name === nameOrId || m.gizmoId === nameOrId || m.key.includes(nameOrId),
  );
  if (local) return local;
  // Then remote by name or id
  return remote.find((p) => p.name === nameOrId || p.id === nameOrId) ?? null;
}

function memoryFilePathHint(gizmoId: string): string {
  return `~/.cgpro/projects/${gizmoId}/memory.md`;
}

function shortenKey(k: string): string {
  if (k.length <= 40) return k;
  return "…" + k.slice(-39);
}

export async function projectLinkCmd(
  nameOrId: string,
  opts: ProjectCmdOpts,
): Promise<number> {
  await assertNoDaemon("project link");
  const here = resolveLocalProject();
  const session = await openSession({
    headed: !opts.headless,
    profilePath: opts.profile,
    background: true,
  });
  try {
    await goHome(session.page);
    if (!(await isLoggedIn(session.page, 8_000))) throw new NotLoggedInError();
    const remote = await listProjects(session.page);
    const target =
      remote.find((p) => p.id === nameOrId) ??
      remote.find((p) => p.name === nameOrId) ??
      remote.find((p) => p.name.toLowerCase() === nameOrId.toLowerCase()) ??
      null;
    if (!target) {
      console.error(chalk.red(`✖ No remote project named "${nameOrId}" (and not a g-p- id).`));
      console.error(chalk.dim("  Run `cgpro project list` to see what's available."));
      return 1;
    }
    const m = upsertMapping({
      key: here.key,
      name: target.name,
      gizmoId: target.id,
      shortUrl: target.shortUrl,
    });
    console.log(chalk.green(`✓ Linked ${chalk.bold(here.key)} → ${chalk.bold(m.name)} (${m.gizmoId})`));
    return 0;
  } finally {
    await session.close();
  }
}

export function projectUnlinkCmd(): number {
  const here = resolveLocalProject();
  const removed = removeMapping(here.key);
  if (!removed) {
    console.log(chalk.dim(`(no link to remove for ${here.key})`));
    return 0;
  }
  console.log(chalk.green(`✓ Unlinked ${here.key}`));
  return 0;
}

export interface ProjectCreateOpts extends ProjectCmdOpts {
  description?: string;
  instructions?: string;
}

export async function projectCreateCmd(
  name: string | undefined,
  _opts: ProjectCreateOpts,
): Promise<number> {
  // Project creation via the public-ish API isn't reachable: every probed
  // path returns 404/405/422 and the kind/type discriminators on
  // /backend-api/gizmos still produce a Custom GPT (g- prefix), not a
  // Project (g-p- prefix). UI automation would work but is fragile.
  // Until we capture the network request the chatgpt.com UI fires when
  // the user clicks "+ New project", we ask the user to do that step
  // themselves — then `cgpro project link` to wire it up.
  const here = resolveLocalProject();
  const suggested = name ?? here.displayName;
  console.log(chalk.yellow("⚠  Project creation isn't yet automated."));
  console.log("");
  console.log("In chatgpt.com:");
  console.log(`  1. Sidebar → ${chalk.bold("Projects")} → ${chalk.bold("+ New project")}`);
  console.log(`  2. Name it: ${chalk.bold(`"${suggested}"`)}`);
  console.log(`  3. (Optional) add custom instructions / files`);
  console.log("");
  console.log("Then run:");
  console.log(`  ${chalk.bold(`cgpro project link "${suggested}"`)}`);
  console.log("");
  console.log(chalk.dim(`Or link to any of your existing 5 projects with the same command.`));
  return 0;
}

export interface ProjectDigestOpts extends ProjectCmdOpts {
  /** How many recent project conversations to summarise. */
  limit?: number;
  /** Print the digest before writing it. */
  dryRun?: boolean;
}

export async function projectDigestCmd(opts: ProjectDigestOpts): Promise<number> {
  await assertNoDaemon("project digest");
  const here = resolveLocalProject();
  const mapping = findMappingByKey(here.key);
  if (!mapping) {
    console.error(chalk.red(`✖ Current cwd is not linked to a project.`));
    console.error(chalk.dim("  Run `cgpro project create` or `cgpro project link <name>` first."));
    return 1;
  }
  const limit = opts.limit ?? 5;

  // Step 1: list recent project conversations (titles + ids)
  const session = await openSession({
    headed: !opts.headless,
    profilePath: opts.profile,
    background: true,
  });
  let recent;
  try {
    await goHome(session.page);
    if (!(await isLoggedIn(session.page, 8_000))) throw new NotLoggedInError();
    recent = await listProjectConversations(session.page, mapping.gizmoId, "0", limit);
  } finally {
    await session.close();
  }
  if (recent.length === 0) {
    console.log(chalk.dim("(no conversations in this project yet — nothing to digest)"));
    return 0;
  }

  // Step 2: ask GPT-5.5 Pro to summarise the titles into 3-7 bullet
  // memory points worth keeping. We don't yet pull conversation bodies
  // (the per-conv get endpoint exists but is rate-limited; titles are
  // a useful start that round-trips cheaply).
  const titles = recent.map((c) => `- ${c.id}: ${c.title}`).join("\n");
  const prompt =
    `You are maintaining a long-running memory file for a ChatGPT Project linked ` +
    `to a developer's local working directory. Below are the titles of the ` +
    `${recent.length} most recent conversations in this project. Write a short ` +
    `digest (3-7 bullets, max 60 words each) of *load-bearing* decisions, ` +
    `unresolved questions, and active workstreams that future ChatGPT turns in ` +
    `this project should remember. Skip filler. Output bullets only, no preamble.\n\n` +
    `Project: ${mapping.name}\nLocal key: ${mapping.key}\n\n${titles}`;

  console.log(chalk.dim(`(asking GPT-5.5 Pro to digest ${recent.length} conv titles…)`));
  const runner = runAsk({
    prompt,
    web: false,
    timeoutSec: 600,
    headless: false,
    background: true,
    profile: opts.profile,
  });
  let buffer = "";
  for await (const ev of runner.events) {
    if (ev.type === "delta") buffer += ev.text;
    else if (ev.type === "error") {
      console.error(chalk.red(`✖ Digest generation failed: ${ev.message}`));
      return 1;
    } else if (ev.type === "done") {
      buffer = ev.finalText ?? buffer;
    }
  }
  await runner.result;
  const digest = buffer.trim();
  if (digest.length === 0) {
    console.error(chalk.red("✖ Empty digest — bailing."));
    return 1;
  }

  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const section = `## ${stamp} — ${recent.length} convs digested\n\n${digest}`;
  if (opts.dryRun) {
    console.log("--- DRY RUN ---\n" + section);
    return 0;
  }
  appendProjectMemory(mapping.gizmoId, section);
  console.log(chalk.green(`✓ Appended ${digest.length} chars to ${memoryFilePathHint(mapping.gizmoId)}`));
  return 0;
}

void findThread; // re-export shim placeholder

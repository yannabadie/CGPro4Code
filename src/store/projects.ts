/**
 * Local mapping: Claude Code project (cwd or git remote) → ChatGPT
 * project (gizmo). Persists in `~/.cgpro/projects.json`.
 *
 * Identity strategy (locked per advisor 2026-04-25):
 *   1. If the cwd is inside a git repo with a remote, use the canonical
 *      remote URL (lowercased, `.git` stripped, trailing slash stripped).
 *      This survives `git clone` to a different directory.
 *   2. Otherwise use the absolute, canonicalized cwd path. Lowercase on
 *      Windows.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { CGPRO_HOME, ensureDirs } from "./paths.js";

const PROJECTS_FILE = join(CGPRO_HOME, "projects.json");

export interface ProjectMapping {
  /** The local project key — git remote URL or cwd path. */
  key: string;
  /** Human-friendly name for display. */
  name: string;
  /** ChatGPT gizmo id (`g-p-...`). */
  gizmoId: string;
  /** Stable short URL slug for `/g/{slug}/project`. */
  shortUrl?: string;
  /** ISO timestamp the link was created. */
  linkedAt: string;
}

interface ProjectsFile {
  version: 1;
  mappings: ProjectMapping[];
}

const EMPTY: ProjectsFile = { version: 1, mappings: [] };

function read(): ProjectsFile {
  ensureDirs();
  if (!existsSync(PROJECTS_FILE)) return { ...EMPTY, mappings: [] };
  try {
    const raw = readFileSync(PROJECTS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ProjectsFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.mappings)) {
      return { ...EMPTY, mappings: [] };
    }
    return { version: 1, mappings: parsed.mappings as ProjectMapping[] };
  } catch {
    return { ...EMPTY, mappings: [] };
  }
}

function write(file: ProjectsFile): void {
  ensureDirs();
  const tmp = `${PROJECTS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), "utf-8");
  renameSync(tmp, PROJECTS_FILE);
}

export function listMappings(): ProjectMapping[] {
  return read().mappings;
}

export function findMappingByKey(key: string): ProjectMapping | null {
  return read().mappings.find((m) => m.key === key) ?? null;
}

export function findMappingByGizmoId(gizmoId: string): ProjectMapping | null {
  return read().mappings.find((m) => m.gizmoId === gizmoId) ?? null;
}

export function upsertMapping(m: Omit<ProjectMapping, "linkedAt"> & { linkedAt?: string }): ProjectMapping {
  const file = read();
  const existing = file.mappings.find((x) => x.key === m.key);
  const now = m.linkedAt ?? new Date().toISOString();
  if (existing) {
    existing.gizmoId = m.gizmoId;
    existing.name = m.name;
    existing.shortUrl = m.shortUrl;
    existing.linkedAt = now;
    write(file);
    return existing;
  }
  const created: ProjectMapping = { ...m, linkedAt: now };
  file.mappings.push(created);
  write(file);
  return created;
}

export function removeMapping(key: string): boolean {
  const file = read();
  const before = file.mappings.length;
  file.mappings = file.mappings.filter((m) => m.key !== key);
  const removed = file.mappings.length < before;
  if (removed) write(file);
  return removed;
}

// ---- Project key resolution ------------------------------------------

export interface ProjectIdentity {
  /** Stable canonical key for the local mapping. */
  key: string;
  /** Human display name for create-project / list output. */
  displayName: string;
  /** Whether the key came from git or the cwd. */
  source: "git" | "cwd";
}

export function resolveLocalProject(cwd: string = process.cwd()): ProjectIdentity {
  const remote = tryGetGitRemote(cwd);
  if (remote) {
    return {
      key: remote.canonical,
      displayName: remote.basename,
      source: "git",
    };
  }
  const abs = resolve(cwd);
  return {
    key: process.platform === "win32" ? abs.toLowerCase() : abs,
    displayName: lastSegment(abs),
    source: "cwd",
  };
}

interface RemoteInfo {
  /** Lowercased, scheme-stripped, .git-stripped, no trailing slash. */
  canonical: string;
  /** Last URL segment (good display name). */
  basename: string;
}

function tryGetGitRemote(cwd: string): RemoteInfo | null {
  try {
    const url = execFileSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], {
      encoding: "utf-8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!url) return null;
    return canonicalizeGitUrl(url);
  } catch {
    return null;
  }
}

export function canonicalizeGitUrl(url: string): RemoteInfo {
  let s = url.trim();
  // Strip auth/scheme.
  s = s.replace(/^[a-z]+:\/\//i, "");
  s = s.replace(/^[^@]+@/, "");
  // SSH form: host:owner/repo → host/owner/repo
  s = s.replace(/^([^/]+):(?!\/)/, "$1/");
  // Drop trailing .git and trailing /
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");
  const lower = s.toLowerCase();
  const parts = lower.split("/").filter(Boolean);
  return {
    canonical: lower,
    basename: parts[parts.length - 1] ?? lower,
  };
}

function lastSegment(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

// ---- Local memory store (one memory.md per linked project) ----------

import { readFileSync as rfs, writeFileSync as wfs } from "node:fs";

export function memoryFilePath(gizmoId: string): string {
  ensureDirs();
  const dir = join(CGPRO_HOME, "projects", gizmoId);
  mkdirSync(dir, { recursive: true });
  return join(dir, "memory.md");
}

export function readProjectMemory(gizmoId: string): string {
  const path = memoryFilePath(gizmoId);
  if (!existsSync(path)) return "";
  try {
    return rfs(path, "utf-8");
  } catch {
    return "";
  }
}

export function writeProjectMemory(gizmoId: string, content: string): void {
  wfs(memoryFilePath(gizmoId), content, "utf-8");
}

export function appendProjectMemory(gizmoId: string, section: string): void {
  const existing = readProjectMemory(gizmoId);
  const sep = existing.length === 0 ? "" : "\n\n---\n\n";
  writeProjectMemory(gizmoId, existing + sep + section);
}

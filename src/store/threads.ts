import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { THREADS_FILE, ensureDirs } from "./paths.js";

export interface ThreadRecord {
  name: string;
  id: string;
  model?: string;
  title?: string;
  created_at: string;
  updated_at: string;
}

interface ThreadsFile {
  version: 1;
  threads: ThreadRecord[];
}

const EMPTY: ThreadsFile = { version: 1, threads: [] };

function read(): ThreadsFile {
  ensureDirs();
  if (!existsSync(THREADS_FILE)) return { ...EMPTY, threads: [] };
  try {
    const raw = readFileSync(THREADS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as ThreadsFile;
    if (!parsed.threads) return { ...EMPTY, threads: [] };
    return parsed;
  } catch {
    return { ...EMPTY, threads: [] };
  }
}

function write(file: ThreadsFile): void {
  ensureDirs();
  const tmp = `${THREADS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), "utf-8");
  renameSync(tmp, THREADS_FILE);
}

export function listThreads(): ThreadRecord[] {
  return read().threads;
}

export function findThread(nameOrId: string): ThreadRecord | null {
  const threads = read().threads;
  return (
    threads.find((t) => t.name === nameOrId) ??
    threads.find((t) => t.id === nameOrId) ??
    null
  );
}

export async function saveThread(
  name: string,
  id: string,
  model?: string,
  title?: string,
): Promise<ThreadRecord> {
  const file = read();
  const now = new Date().toISOString();
  const existingByName = file.threads.find((t) => t.name === name);
  if (existingByName) {
    existingByName.id = id;
    existingByName.model = model ?? existingByName.model;
    existingByName.title = title ?? existingByName.title;
    existingByName.updated_at = now;
    write(file);
    return existingByName;
  }
  const existingById = file.threads.find((t) => t.id === id);
  if (existingById) {
    existingById.name = name;
    existingById.updated_at = now;
    if (model && !existingById.model) existingById.model = model;
    write(file);
    return existingById;
  }
  const record: ThreadRecord = {
    name,
    id,
    model,
    title,
    created_at: now,
    updated_at: now,
  };
  file.threads.push(record);
  write(file);
  return record;
}

export function removeThread(nameOrId: string): boolean {
  const file = read();
  const before = file.threads.length;
  file.threads = file.threads.filter((t) => t.name !== nameOrId && t.id !== nameOrId);
  const removed = file.threads.length < before;
  if (removed) write(file);
  return removed;
}

export function renameThread(oldName: string, newName: string): ThreadRecord | null {
  const file = read();
  const t = file.threads.find((t) => t.name === oldName);
  if (!t) return null;
  if (file.threads.some((other) => other.name === newName)) {
    throw new Error(`A thread named "${newName}" already exists.`);
  }
  t.name = newName;
  t.updated_at = new Date().toISOString();
  write(file);
  return t;
}

/**
 * Local cache of the chatgpt.com conversation list — separate from
 * `threads.json` (which is the user's *named* bookmark set). Snapshot
 * is overwritten by every `cgpro thread sync` call.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { CGPRO_HOME, ensureDirs } from "./paths.js";
import type { RemoteConversation } from "../api/conversations.js";

const CACHE_FILE = join(CGPRO_HOME, "conversations-cache.json");

interface CacheFile {
  version: 1;
  fetchedAt: string;
  count: number;
  conversations: RemoteConversation[];
}

export function readConversationsCache(): CacheFile | null {
  ensureDirs();
  if (!existsSync(CACHE_FILE)) return null;
  try {
    const raw = readFileSync(CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CacheFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.conversations)) return null;
    return {
      version: 1,
      fetchedAt: parsed.fetchedAt ?? "",
      count: parsed.conversations.length,
      conversations: parsed.conversations as RemoteConversation[],
    };
  } catch {
    return null;
  }
}

export function writeConversationsCache(conversations: RemoteConversation[]): void {
  ensureDirs();
  const file: CacheFile = {
    version: 1,
    fetchedAt: new Date().toISOString(),
    count: conversations.length,
    conversations,
  };
  const tmp = `${CACHE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), "utf-8");
  renameSync(tmp, CACHE_FILE);
}

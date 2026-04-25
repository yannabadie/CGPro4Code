/**
 * Cross-call session state for ephemeral conversations.
 *
 * Design tradeoff: walking the Windows process tree to find a stable
 * "Claude Code" anchor PID is fragile (intermediate shells die between
 * our calls; PowerShell lookups intermittently fail). Instead we use a
 * pure TTL: if a conversation was last used recently, the next `cgpro
 * ask` resumes it; otherwise it starts a fresh ephemeral chat.
 *
 * The TTL window covers the typical pause between two operator
 * questions in a Claude Code session. Pass `--new-session` to skip the
 * resume explicitly.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CGPRO_HOME, ensureDirs } from "./paths.js";

const SESSION_FILE = join(CGPRO_HOME, "session.json");
const TTL_MS = 30 * 60 * 1000; // 30 minutes

interface SessionRecord {
  conversationId: string;
  startedAt: string;
  lastUsedAt: string;
}

interface SessionFile {
  version: 2;
  current: SessionRecord | null;
}

const EMPTY: SessionFile = { version: 2, current: null };

function read(): SessionFile {
  ensureDirs();
  if (!existsSync(SESSION_FILE)) return { ...EMPTY };
  try {
    const raw = readFileSync(SESSION_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SessionFile>;
    if (parsed.version === 2 && parsed.current !== undefined) {
      return { version: 2, current: parsed.current };
    }
    // Old v1 format — discard.
    return { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

function write(file: SessionFile): void {
  ensureDirs();
  writeFileSync(SESSION_FILE, JSON.stringify(file, null, 2), "utf-8");
}

/** Returns the active conversation id if it's still within the TTL window. */
export function getActiveConversationId(): string | null {
  const file = read();
  if (!file.current) return null;
  const lastUsed = Date.parse(file.current.lastUsedAt);
  if (!Number.isFinite(lastUsed)) return null;
  if (Date.now() - lastUsed > TTL_MS) {
    // Expired — clear it.
    write({ ...EMPTY });
    return null;
  }
  return file.current.conversationId;
}

/** Persist a new (or refreshed) ephemeral conversation id. */
export function saveActiveConversationId(conversationId: string): void {
  const now = new Date().toISOString();
  const file = read();
  if (file.current?.conversationId === conversationId) {
    file.current.lastUsedAt = now;
  } else {
    file.current = {
      conversationId,
      startedAt: now,
      lastUsedAt: now,
    };
  }
  write(file);
}

/** Wipe the active session — use after `--new-session` or by user request. */
export function clearActiveConversation(): void {
  write({ ...EMPTY });
}

import { describe, it, expect, beforeEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Force a sandbox CGPRO_HOME before importing the cache module so it
// reads/writes inside the test temp dir, not the user's real ~/.cgpro.
const tmpRoot = mkdtempSync(join(tmpdir(), "cgpro-cache-test-"));
mkdirSync(join(tmpRoot, "logs"), { recursive: true });

vi.mock("../src/store/paths.js", () => ({
  CGPRO_HOME: tmpRoot,
  PROFILE_DIR: join(tmpRoot, "profile"),
  THREADS_FILE: join(tmpRoot, "threads.json"),
  CONFIG_FILE: join(tmpRoot, "config.json"),
  LOG_DIR: join(tmpRoot, "logs"),
  ensureDirs: () => {
    /* no-op */
  },
  profileDir: (override?: string) => override ?? join(tmpRoot, "profile"),
}));

const {
  readConversationsCache,
  writeConversationsCache,
} = await import("../src/store/conversations-cache.js");

describe("conversations-cache", () => {
  beforeEach(() => {
    rmSync(join(tmpRoot, "conversations-cache.json"), { force: true });
  });

  it("returns null when the file does not exist", () => {
    expect(readConversationsCache()).toBeNull();
  });

  it("writes and reads back a snapshot", () => {
    writeConversationsCache([
      { id: "11111111-1111-1111-1111-111111111111", title: "Hello", source: "api" },
      { id: "22222222-2222-2222-2222-222222222222", title: "World", source: "dom" },
    ]);
    const cache = readConversationsCache();
    expect(cache).not.toBeNull();
    expect(cache!.count).toBe(2);
    expect(cache!.conversations[0].title).toBe("Hello");
    expect(cache!.conversations[1].source).toBe("dom");
    expect(cache!.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("ignores files written by an unknown schema version", async () => {
    writeConversationsCache([{ id: "33333333-3333-3333-3333-333333333333", title: "Z", source: "api" }]);
    const fs = await import("node:fs");
    fs.writeFileSync(
      join(tmpRoot, "conversations-cache.json"),
      JSON.stringify({ version: 999, conversations: [] }),
    );
    expect(readConversationsCache()).toBeNull();
  });
});

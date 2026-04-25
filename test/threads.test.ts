import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;

vi.mock("../src/store/paths.js", async () => {
  const real = await vi.importActual<typeof import("../src/store/paths.js")>(
    "../src/store/paths.js",
  );
  return {
    ...real,
    get CGPRO_HOME() {
      return tmpRoot;
    },
    get THREADS_FILE() {
      return join(tmpRoot, "threads.json");
    },
    get LOG_DIR() {
      return join(tmpRoot, "logs");
    },
    get PROFILE_DIR() {
      return join(tmpRoot, "profile");
    },
    ensureDirs() {
      // no-op for tests
    },
  };
});

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "cgpro-test-"));
  return () => {
    rmSync(tmpRoot, { recursive: true, force: true });
  };
});

describe("threads store", () => {
  it("saves, finds, lists, removes a thread by name", async () => {
    const { saveThread, findThread, listThreads, removeThread } = await import(
      "../src/store/threads.js"
    );
    const id = "11111111-1111-1111-1111-111111111111";
    await saveThread("foo", id, "gpt-5-pro");
    expect(findThread("foo")?.id).toBe(id);
    expect(findThread(id)?.name).toBe("foo");
    expect(listThreads().length).toBe(1);
    expect(removeThread("foo")).toBe(true);
    expect(listThreads().length).toBe(0);
  });

  it("renames a thread", async () => {
    const { saveThread, renameThread, findThread } = await import(
      "../src/store/threads.js"
    );
    const id = "22222222-2222-2222-2222-222222222222";
    await saveThread("old", id);
    renameThread("old", "new");
    expect(findThread("new")?.id).toBe(id);
    expect(findThread("old")).toBeNull();
  });

  it("refuses to rename onto an existing name", async () => {
    const { saveThread, renameThread } = await import("../src/store/threads.js");
    await saveThread("a", "33333333-3333-3333-3333-333333333333");
    await saveThread("b", "44444444-4444-4444-4444-444444444444");
    expect(() => renameThread("a", "b")).toThrow(/already exists/);
  });

  it("upserts when saving an existing name with a new id", async () => {
    const { saveThread, findThread } = await import("../src/store/threads.js");
    const id1 = "55555555-5555-5555-5555-555555555555";
    const id2 = "66666666-6666-6666-6666-666666666666";
    await saveThread("foo", id1);
    await saveThread("foo", id2);
    expect(findThread("foo")?.id).toBe(id2);
  });
});

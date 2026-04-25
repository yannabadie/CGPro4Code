import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Sandbox CGPRO_HOME so the daemon.json file goes to a tmp dir.
const tmpRoot = mkdtempSync(join(tmpdir(), "cgpro-daemon-test-"));
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

const { writeDaemonInfo, readDaemonInfo, clearDaemonInfo } = await import(
  "../src/daemon/protocol.js"
);

describe("daemon protocol", () => {
  it("round-trips daemon.json", () => {
    writeDaemonInfo({
      version: 1,
      pid: 4242,
      port: 49100,
      token: "a".repeat(64),
      startedAt: "2026-04-25T20:00:00.000Z",
      profile: "/tmp/foo",
      background: true,
    });
    const back = readDaemonInfo();
    expect(back).not.toBeNull();
    expect(back!.pid).toBe(4242);
    expect(back!.port).toBe(49100);
    expect(back!.token).toHaveLength(64);
    expect(back!.background).toBe(true);
    clearDaemonInfo();
    expect(readDaemonInfo()).toBeNull();
  });

  it("ignores files with the wrong version", async () => {
    const fs = await import("node:fs");
    fs.writeFileSync(
      join(tmpRoot, "daemon.json"),
      JSON.stringify({ version: 999, pid: 1, port: 2, token: "x" }),
    );
    expect(readDaemonInfo()).toBeNull();
    clearDaemonInfo();
  });

  it("ignores files missing required fields", async () => {
    const fs = await import("node:fs");
    fs.writeFileSync(
      join(tmpRoot, "daemon.json"),
      JSON.stringify({ version: 1, pid: 1 }),
    );
    expect(readDaemonInfo()).toBeNull();
    clearDaemonInfo();
  });
});

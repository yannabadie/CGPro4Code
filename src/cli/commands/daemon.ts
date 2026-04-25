/**
 * `cgpro daemon start | stop | status` — user-facing controls for the
 * long-lived browser process. The actual server loop is in
 * `src/daemon/server.ts` and runs in a separate, detached child.
 */

import { spawn } from "node:child_process";
import chalk from "chalk";
import ora from "ora";
import {
  getDaemonStatus,
  getLiveDaemon,
  shutdownDaemon,
} from "../../daemon/client.js";
import {
  clearDaemonInfo,
  pidIsAlive,
  readDaemonInfo,
  DAEMON_LOG,
} from "../../daemon/protocol.js";
import { runDaemonServer } from "../../daemon/server.js";

export interface DaemonStartOptions {
  profile?: string;
  background?: boolean;
}

export async function daemonStartCmd(opts: DaemonStartOptions): Promise<number> {
  const existing = await getLiveDaemon();
  if (existing) {
    console.log(chalk.yellow(`Daemon already running (pid ${existing.pid}, port ${existing.port}).`));
    return 0;
  }

  // If there's a stale daemon.json from a crashed previous run, wipe it
  // so the freshly-spawned daemon can write its own.
  const stale = readDaemonInfo();
  if (stale && !pidIsAlive(stale.pid)) {
    clearDaemonInfo();
  }

  const args = ["daemon-server"];
  if (opts.profile) args.push("--profile", opts.profile);
  if (opts.background === false) args.push("--no-background");

  const spinner = ora("Spawning daemon…").start();
  const child = spawn(process.argv[0], [process.argv[1], ...args], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, CGPRO_DAEMON: "1" },
  });
  child.unref();

  // Poll for daemon.json + healthz. Browser warmup can take 5-10s.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const info = await getLiveDaemon();
    if (info) {
      spinner.succeed(`Daemon up — pid ${info.pid}, port ${info.port}.`);
      console.log(chalk.dim(`  log: ${DAEMON_LOG}`));
      return 0;
    }
    await sleep(500);
  }
  spinner.fail("Daemon did not come up in 60s.");
  console.error(chalk.dim(`  Check ${DAEMON_LOG} for details.`));
  return 1;
}

export async function daemonStopCmd(): Promise<number> {
  const info = readDaemonInfo();
  if (!info) {
    console.log(chalk.dim("No daemon registered."));
    return 0;
  }

  const live = await getLiveDaemon();
  if (live) {
    const ok = await shutdownDaemon(live);
    if (ok) {
      // Wait briefly for the file to disappear.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (!readDaemonInfo()) break;
        await sleep(150);
      }
      console.log(chalk.green("✓ Daemon stopped."));
      return 0;
    }
    console.log(chalk.yellow("Graceful shutdown failed — sending SIGTERM."));
  }

  if (pidIsAlive(info.pid)) {
    try {
      process.kill(info.pid, "SIGTERM");
    } catch {
      /* ignore */
    }
    await sleep(500);
    if (pidIsAlive(info.pid)) {
      try {
        process.kill(info.pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
  clearDaemonInfo();
  console.log(chalk.green("✓ Daemon stopped (forced)."));
  return 0;
}

export async function daemonStatusCmd(opts: { json?: boolean }): Promise<number> {
  const info = readDaemonInfo();
  if (!info) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ running: false }) + "\n");
    } else {
      console.log(chalk.dim("Daemon: not running."));
    }
    return 0;
  }
  const live = await getLiveDaemon();
  if (!live) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ running: false, stale: info }) + "\n");
    } else {
      console.log(chalk.yellow(`Daemon registered (pid ${info.pid}) but not responding.`));
      console.log(chalk.dim("  Run `cgpro daemon stop` to clear, then `cgpro daemon start`."));
    }
    return 0;
  }
  const status = await getDaemonStatus(live);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ running: true, info: live, status }, null, 2) + "\n");
    return 0;
  }
  console.log(chalk.bold("Daemon: running"));
  console.log(`  pid:           ${live.pid}`);
  console.log(`  port:          ${live.port}`);
  console.log(`  started:       ${live.startedAt}`);
  if (status) {
    console.log(`  uptime:        ${formatDuration(status.uptimeSec)}`);
    console.log(`  busy:          ${status.busy ? chalk.yellow("yes") : "no"}`);
    if (status.currentConversation) {
      console.log(`  current:       ${status.currentConversation}`);
    }
    if (status.lastConversation) {
      console.log(`  last:          ${status.lastConversation}`);
    }
  }
  console.log(chalk.dim(`  log:           ${DAEMON_LOG}`));
  return 0;
}

/** Hidden command — invoked by `daemon start` after spawning a child. */
export interface DaemonServerCliOptions {
  profile?: string;
  background?: boolean;
}

export async function daemonServerCmd(opts: DaemonServerCliOptions): Promise<number> {
  await runDaemonServer({
    profile: opts.profile,
    background: opts.background ?? true,
  });
  // runDaemonServer keeps the event loop alive (HTTP listener). Don't
  // return here — the process exits via SIGTERM / /shutdown.
  return await new Promise<number>(() => {
    /* never resolves */
  });
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

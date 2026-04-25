/**
 * Discovery + import of the OpenAI ChatGPT desktop app's session into our
 * cgpro profile. The desktop app is an Electron / Chromium build; its data
 * directory has the same shape as a Chromium user-data-dir, so copying the
 * cookies + storage + Local State (which holds the DPAPI-protected
 * encryption key) gives our headed Chromium an authenticated session
 * without the user signing in again.
 */

import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Files & directories we copy from the app's data dir into ours. */
const ARTIFACTS = [
  "Local State",
  "Preferences",
  "Network", // contains Cookies + Cookies-journal + TransportSecurity
  "Local Storage",
  "Session Storage",
  "IndexedDB",
  "WebStorage",
  "Shared Dictionary",
  "SharedStorage",
];

export interface AppLocation {
  /** Root data dir (where Local State + Network/ live). */
  dataDir: string;
  /** Human label for messages. */
  label: string;
}

/**
 * Scan known install paths for the ChatGPT desktop app. Returns the first
 * one that exists (and looks valid).
 */
export function findChatGptApp(): AppLocation | null {
  const home = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Local");
  const candidates: AppLocation[] = [
    {
      label: "OpenAI ChatGPT (Microsoft Store)",
      dataDir: join(
        home,
        "Packages",
        "OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0",
        "LocalCache",
        "Roaming",
        "ChatGPT",
      ),
    },
    {
      label: "ChatGPT (standalone Electron build)",
      dataDir: join(process.env.APPDATA ?? "", "ChatGPT"),
    },
  ];
  for (const c of candidates) {
    if (existsSync(c.dataDir) && existsSync(join(c.dataDir, "Local State"))) {
      return c;
    }
  }
  return null;
}

/**
 * Returns true if any ChatGPT*.exe process is currently running.
 */
export async function isAppRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileP(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-Process | Where-Object { $_.ProcessName -like 'ChatGPT*' } | Select-Object -First 1 | ForEach-Object { 'yes' }",
      ],
      { windowsHide: true, timeout: 10_000 },
    );
    return stdout.trim() === "yes";
  } catch {
    return false;
  }
}

/**
 * Force-close the ChatGPT app. Returns true if anything was killed.
 * Used only when the user explicitly asks (e.g. --kill-app).
 */
export async function killApp(): Promise<boolean> {
  try {
    await execFileP("taskkill", ["/F", "/IM", "ChatGPT.exe"], {
      windowsHide: true,
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the auth-bearing artifacts from the ChatGPT app's data dir into
 * our cgpro profile dir. Caller must ensure the app is not running.
 *
 * The cgpro profile is a Playwright launchPersistentContext target,
 * which Chromium expects laid out as `<profileDir>/Default/...`. We
 * place the Network/, Local Storage/ etc. inside `<profileDir>/Default/`
 * and the `Local State` file at the profile root.
 */
export function importAppProfile(appDir: string, profileDir: string): {
  copied: string[];
  skipped: string[];
} {
  const defaultDir = join(profileDir, "Default");
  mkdirSync(defaultDir, { recursive: true });

  const copied: string[] = [];
  const skipped: string[] = [];

  for (const name of ARTIFACTS) {
    const src = join(appDir, name);
    if (!existsSync(src)) {
      skipped.push(name);
      continue;
    }
    // "Local State" lives at the profile root; everything else under Default/.
    const dst = name === "Local State" ? join(profileDir, "Local State") : join(defaultDir, name);
    try {
      copyAny(src, dst);
      copied.push(name);
    } catch {
      skipped.push(name);
    }
  }

  return { copied, skipped };
}

function copyAny(src: string, dst: string): void {
  const s = statSync(src);
  if (s.isFile()) {
    mkdirSync(join(dst, ".."), { recursive: true });
    copyFileSync(src, dst);
    return;
  }
  if (s.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyAny(join(src, entry), join(dst, entry));
    }
  }
}

/**
 * Removes any existing Default/ + Local State so a re-import starts clean.
 */
export function clearProfile(profileDir: string): void {
  const def = join(profileDir, "Default");
  if (existsSync(def)) rmSync(def, { recursive: true, force: true });
  const ls = join(profileDir, "Local State");
  if (existsSync(ls)) rmSync(ls, { force: true });
}

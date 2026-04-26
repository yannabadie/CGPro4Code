import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { CONFIG_FILE, ensureDirs } from "./paths.js";

export interface CgproConfig {
  /** Optional. When unset, chatgpt.com picks the user's account default. */
  defaultModel?: string;
  defaultWeb: boolean;
  defaultHeadless: boolean;
  timeoutSec: number;
}

const DEFAULTS: CgproConfig = {
  // GPT-5.5 Pro is the entire reason cgpro exists. Force the slug —
  // earlier comment claimed Pro accounts default to it server-side
  // but the user's account actually defaults to gpt-5-5-thinking and
  // we silently used that instead. Verified via `cgpro status` that
  // this slug is in the user's catalogue.
  defaultModel: "gpt-5-5-pro",
  defaultWeb: true,
  defaultHeadless: false,
  // GPT-5.5 Pro extended-thinking turns can run over an hour for hard
  // problems. Default to 2h; user can lower via --timeout for ergonomics
  // on quick turns or raise it explicitly. The daemon clamps separately.
  timeoutSec: 7_200,
};

export function loadConfig(): CgproConfig {
  ensureDirs();
  if (!existsSync(CONFIG_FILE)) {
    return { ...DEFAULTS };
  }
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CgproConfig>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg: CgproConfig): void {
  ensureDirs();
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
}

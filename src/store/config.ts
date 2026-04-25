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
  // Intentionally undefined: ChatGPT Pro accounts default to gpt-5-5-pro
  // server-side, and forcing a slug like "gpt-5-pro" via ?model= breaks
  // when the slug isn't recognised. Pass --model to override.
  defaultModel: undefined,
  defaultWeb: true,
  defaultHeadless: false,
  timeoutSec: 600,
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

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { CONFIG_FILE, ensureDirs } from "./paths.js";

export interface CgproConfig {
  defaultModel: string;
  defaultWeb: boolean;
  defaultHeadless: boolean;
  timeoutSec: number;
}

const DEFAULTS: CgproConfig = {
  defaultModel: "gpt-5-pro",
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

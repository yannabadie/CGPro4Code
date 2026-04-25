import envPaths from "env-paths";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const paths = envPaths("cgpro", { suffix: "" });

export const CGPRO_HOME = paths.data;
export const PROFILE_DIR = join(CGPRO_HOME, "profile");
export const THREADS_FILE = join(CGPRO_HOME, "threads.json");
export const CONFIG_FILE = join(CGPRO_HOME, "config.json");
export const LOG_DIR = join(CGPRO_HOME, "logs");

export function ensureDirs(): void {
  mkdirSync(CGPRO_HOME, { recursive: true });
  mkdirSync(PROFILE_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
}

export function profileDir(override?: string): string {
  return override ?? PROFILE_DIR;
}

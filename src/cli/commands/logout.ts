import { rmSync, existsSync } from "node:fs";
import chalk from "chalk";
import prompts from "prompts";
import { profileDir } from "../../store/paths.js";
import { assertNoDaemon } from "../../daemon/client.js";

export interface LogoutOptions {
  profile?: string;
  yes?: boolean;
}

export async function logoutCommand(opts: LogoutOptions): Promise<number> {
  await assertNoDaemon("logout");
  const dir = profileDir(opts.profile);
  if (!existsSync(dir)) {
    console.log(chalk.dim("No profile to remove."));
    return 0;
  }
  if (!opts.yes) {
    const { confirm } = await prompts({
      type: "confirm",
      name: "confirm",
      message: `Wipe profile at ${dir}? Next ask will require login again.`,
      initial: false,
    });
    if (!confirm) {
      console.log(chalk.dim("Aborted."));
      return 0;
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    console.log(chalk.green(`✓ Profile removed (${dir}).`));
    return 0;
  } catch (err) {
    console.error(chalk.red(`✖ Could not remove profile: ${(err as Error).message}`));
    return 1;
  }
}

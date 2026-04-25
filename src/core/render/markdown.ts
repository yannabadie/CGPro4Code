import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

let configured = false;

function ensureConfigured(): void {
  if (configured) return;
  marked.use(markedTerminal() as any);
  configured = true;
}

/**
 * Render a complete markdown blob to ANSI-styled text. Used for `--no-stream`
 * output and for the `--render` post-stream finalize.
 */
export function renderMarkdown(md: string): string {
  ensureConfigured();
  const out = marked.parse(md);
  return typeof out === "string" ? out : md;
}

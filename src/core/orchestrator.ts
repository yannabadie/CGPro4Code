import type { Page } from "playwright";
import { openSession, type Session } from "../browser/session.js";
import { fetchAuthSession, goHome, isLoggedIn } from "../browser/chatgpt.js";
import {
  currentConversationId,
  openConversation,
  readLatestAssistantText,
  sendPrompt,
  setWebSearch,
  waitTurnComplete,
} from "../browser/conversation.js";
import {
  installSseInterceptor,
  StreamEmitter,
  type StreamEvent,
} from "./stream.js";
import { fetchModels, findProSlug } from "../api/models.js";
import { ModelUnavailableError, NotLoggedInError, TurnTimeoutError } from "../errors.js";

export interface AskOptions {
  prompt: string;
  model?: string;
  web?: boolean;
  images?: string[];
  /** Resume a previous conversation by its chatgpt.com UUID. */
  conversationId?: string;
  timeoutSec: number;
  headless: boolean;
  profile?: string;
}

export interface AskResult {
  conversationId: string | null;
  finalText: string;
  events: StreamEvent[];
}

export interface AskRunner {
  events: AsyncIterable<StreamEvent>;
  result: Promise<AskResult>;
  cancel: () => Promise<void>;
}

/**
 * Drives a single ask turn end to end. Yields stream events to the caller
 * and resolves a final summary once the turn completes (or fails).
 */
export function runAsk(opts: AskOptions): AskRunner {
  const emitter = new StreamEmitter();
  const collected: StreamEvent[] = [];

  let session: Session | null = null;
  let cancelled = false;

  const result: Promise<AskResult> = (async () => {
    session = await openSession({ headed: !opts.headless, profilePath: opts.profile });
    try {
      const page = session.page;
      await goHome(page);
      if (!(await isLoggedIn(page, 10_000))) {
        throw new NotLoggedInError();
      }

      // Resolve the right model slug if the caller asked for the canonical Pro alias.
      let modelSlug = opts.model;
      const wantsPro = !modelSlug || /5[._-]?5[._-]?pro|gpt-5-pro|^pro$/i.test(modelSlug);
      if (wantsPro) {
        const auth = await fetchAuthSession(page);
        const models = await fetchModels(page, auth?.accessToken);
        const pro = findProSlug(models);
        if (!pro) {
          throw new ModelUnavailableError("gpt-5.5-pro");
        }
        modelSlug = pro;
      }

      await installSseInterceptor(page, emitter);

      await openConversation(page, {
        model: modelSlug,
        conversationId: opts.conversationId,
      });

      if (opts.web !== undefined) {
        await setWebSearch(page, opts.web);
      }

      await attachImages(page, opts.images ?? []);

      await sendPrompt(page, opts.prompt);

      // Wait for the network stream OR the DOM stop button to settle.
      await waitTurnComplete(page, opts.timeoutSec * 1_000).catch(() => {
        if (!cancelled) throw new TurnTimeoutError(opts.timeoutSec);
      });

      const conversationId = currentConversationId(page);
      // Prefer interceptor-captured text; fall back to DOM scrape.
      let finalText = "";
      // Drain any pending events to capture the latest finalText
      // The done event already includes finalText from SseParser.cumulativeText.
      const dom = await readLatestAssistantText(page);
      finalText = dom || finalText;

      // Push a definitive done with the DOM-confirmed text.
      emitter.push({ type: "done", finalText });

      return { conversationId, finalText, events: collected };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      emitter.push({ type: "error", message });
      throw err;
    } finally {
      await session?.close().catch(() => {});
    }
  })();

  // Tee the iterator into both the consumer-facing emitter and the result.events array.
  const teed = teeEvents(emitter, collected);

  return {
    events: teed,
    result,
    async cancel(): Promise<void> {
      cancelled = true;
      try {
        await session?.close();
      } catch {
        /* swallow */
      }
    },
  };
}

async function attachImages(page: Page, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const inputs = page.locator('input[type="file"]');
  const count = await inputs.count();
  if (count === 0) return;
  await inputs.first().setInputFiles(paths).catch(() => {
    /* ignore: composer may not accept this batch */
  });
  await page.waitForTimeout(750);
}

async function* teeEvents(
  emitter: StreamEmitter,
  collected: StreamEvent[],
): AsyncIterable<StreamEvent> {
  for await (const ev of emitter) {
    collected.push(ev);
    yield ev;
  }
}

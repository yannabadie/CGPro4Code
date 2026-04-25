import type { Page } from "patchright";
import { openSession, type Session } from "../browser/session.js";
import { goHome, isLoggedIn } from "../browser/chatgpt.js";
import {
  currentConversationId,
  latestAssistantModelSlug,
  openConversation,
  readLatestAssistantText,
  sendPrompt,
  setWebSearch,
  waitTurnComplete,
} from "../browser/conversation.js";
import {
  setActiveEmitter,
  StreamEmitter,
  type StreamEvent,
} from "./stream.js";
import { NotLoggedInError, TurnTimeoutError } from "../errors.js";
import { SELECTORS as SELECTORS_DUMP } from "../browser/selectors.js";

export interface AskOptions {
  prompt: string;
  model?: string;
  web?: boolean;
  images?: string[];
  /** Resume a previous conversation by its chatgpt.com UUID. */
  conversationId?: string;
  timeoutSec: number;
  headless: boolean;
  /** Hide the browser window off-screen for unobtrusive runs. */
  background?: boolean;
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
 *
 * Cold-start path: opens a fresh browser session, runs the turn, closes it.
 * Use `runAskOnSession` to reuse a long-lived session (daemon mode).
 */
export function runAsk(opts: AskOptions): AskRunner {
  return runAskInner(opts, null, true);
}

/**
 * Same as `runAsk` but reuses an existing browser session that the caller
 * owns and won't be closed when the turn completes. Used by the daemon
 * server so multiple turns can share one warm Chromium.
 */
export function runAskOnSession(opts: AskOptions, session: Session): AskRunner {
  return runAskInner(opts, session, false);
}

function runAskInner(
  opts: AskOptions,
  providedSession: Session | null,
  closeOnFinish: boolean,
): AskRunner {
  const emitter = new StreamEmitter();
  const collected: StreamEvent[] = [];

  let session: Session | null = providedSession;
  let cancelled = false;

  const result: Promise<AskResult> = (async () => {
    if (!session) {
      session = await openSession({
        headed: !opts.headless,
        profilePath: opts.profile,
        background: opts.background,
      });
    }
    setActiveEmitter(session.context, emitter);
    try {
      const page = session.page;
      const debug = process.env.CGPRO_DEBUG === "1";
      const log = (m: string): void => {
        if (debug) console.error("[cgpro]", m);
      };
      log("goHome…");
      await goHome(page);
      log(`goHome done, url=${page.url()}`);
      if (!(await isLoggedIn(page, 10_000))) {
        throw new NotLoggedInError();
      }
      log("isLoggedIn ✓");

      // Model resolution:
      // - If caller passed --model, use it verbatim (chatgpt.com falls
      //   back silently to the account default if the slug is unknown).
      // - Otherwise let the page pick the user's default model (which
      //   for ChatGPT Pro accounts is gpt-5-5-pro). We confirm what was
      //   actually used after the turn via data-message-model-slug.
      const modelSlug = opts.model;

      log(
        `openConversation model=${modelSlug ?? "(account default)"} resume=${opts.conversationId ?? "no"}…`,
      );
      await openConversation(page, {
        model: modelSlug,
        conversationId: opts.conversationId,
      });
      log(`openConversation done, url=${page.url()}`);

      if (opts.web !== undefined) {
        log(`setWebSearch ${opts.web}…`);
        await setWebSearch(page, opts.web);
      }

      await attachImages(page, opts.images ?? []);

      log("sendPrompt…");
      const priorBubbles = await sendPrompt(page, opts.prompt);
      log(`sendPrompt done (priorBubbles=${priorBubbles}), url=${page.url()}`);

      // Wait for the turn to settle. The SSE interceptor will normally push
      // a `done` event; if the network missed (cached response, schema we
      // didn't recognize), we fall back to DOM detection.
      log(`waitTurnComplete (timeout ${opts.timeoutSec}s)…`);
      try {
        await waitTurnComplete(page, opts.timeoutSec * 1_000, priorBubbles);
      } catch (err) {
        if (debug) {
          const screenshotPath = `${process.env.TEMP || "."}/cgpro-debug-${Date.now()}.png`;
          await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
          log(`screenshot saved: ${screenshotPath}`);
          const url = page.url();
          const composerCount = await page.locator("#prompt-textarea").count();
          const sendCount = await page.locator('button[data-testid="send-button"]').count();
          const bubbleCount = await page
            .locator(SELECTORS_DUMP.assistantMessages.join(", "))
            .count();
          const composerText = await page
            .locator("#prompt-textarea")
            .first()
            .innerText()
            .catch(() => "");
          log(
            `state: url=${url} composer=${composerCount} send=${sendCount} bubbles=${bubbleCount} composerText=${JSON.stringify(composerText.slice(0, 80))}`,
          );
        }
        if (!cancelled) throw new TurnTimeoutError(opts.timeoutSec);
      }
      log(`waitTurnComplete done, url=${page.url()}`);

      // Conversation id can come from two sources:
      //  - the URL once the page navigates to /c/<uuid> (regular chats)
      //  - the SSE `started` event payload (ephemeral chats keep the
      //    composer URL as-is but the backend still mints a UUID)
      let conversationId = currentConversationId(page);
      if (!conversationId) {
        const startedEv = collected.find((e) => e.type === "started") as
          | { conversationId?: string }
          | undefined;
        if (startedEv?.conversationId) {
          conversationId = startedEv.conversationId;
        }
      }
      const actualModel = await latestAssistantModelSlug(page);
      log(`actualModel=${actualModel ?? "(unknown)"} conv=${conversationId ?? "(none)"}`);

      // Always pull the DOM text — the SSE interceptor may have missed
      // the URL pattern and the DOM is the authoritative final state.
      const domText = await readLatestAssistantText(page);

      if (!emitter.isFinished()) {
        emitter.push({ type: "done", finalText: domText });
      }

      const finalEvent = collected
        .slice()
        .reverse()
        .find((e) => e.type === "done") as { finalText?: string } | undefined;
      const finalText = (finalEvent?.finalText && finalEvent.finalText.length > 0)
        ? finalEvent.finalText
        : domText;

      return { conversationId, finalText, events: collected };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      emitter.push({ type: "error", message });
      throw err;
    } finally {
      // Reset the active emitter so a stale binding doesn't leak into
      // the next turn on the same context (daemon mode).
      if (session) setActiveEmitter(session.context, null);
      if (closeOnFinish) {
        await session?.close().catch(() => {});
      }
    }
  })();

  const teed = teeEvents(emitter, collected);

  return {
    events: teed,
    result,
    async cancel(): Promise<void> {
      cancelled = true;
      // In cold-start mode we own the session, so killing it cancels.
      // In daemon mode we just stop streaming; the daemon decides what
      // to do with the in-flight turn.
      if (closeOnFinish) {
        try {
          await session?.close();
        } catch {
          /* swallow */
        }
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

---
name: cgpro implementation plan
description: Step-by-step build plan for the cgpro CLI - bootstrap, browser session, ask/chat commands, threads, polish
type: plan
date: 2026-04-25
spec: ../specs/2026-04-25-cgpro-design.md
---

# Implementation plan — `cgpro`

Build target: working `cgpro login` + `cgpro ask` against a real ChatGPT Pro account, with `cgpro chat`, threads, and stability hardening following on the same day.

Each phase ends with a green compile + commit. Live-network tests happen at the end of phases B, D, F.

## Phase A — Project bootstrap (~10 min)

- A1. `package.json` — Node 20+, ESM, `bin: { cgpro: "./dist/cli/index.js" }`, `scripts: build|dev|test|lint`.
- A2. `tsconfig.json` — strict, `target: ES2022`, `module: NodeNext`, `outDir: dist`.
- A3. Install runtime deps: `playwright`, `commander`, `chalk@5`, `ora@8`, `marked@13`, `marked-terminal@7`, `prompts@2`, `mime`, `env-paths`.
- A4. Install dev deps: `typescript`, `@types/node`, `vitest`, `tsx`, `@playwright/test`, `eslint`, `prettier`.
- A5. `.gitignore` (node_modules, dist, .cgpro, .env, .playwright).
- A6. `README.md` — stub (we'll fill at end).
- A7. `npx playwright install chromium` — pin browser.
- A8. Commit: `chore: scaffold node/ts/playwright project`.

## Phase B — Browser session foundation (~25 min)

- B1. `src/store/paths.ts` — resolve `~/.cgpro/{profile,threads.json,config.json,logs/}` cross-platform via `env-paths`.
- B2. `src/browser/selectors.ts` — first selector pass:
  - `composer` → `getByRole("textbox", { name: /(message|envoyer)/i })` fallback `[data-testid="prompt-textarea"]`.
  - `sendButton` → `getByRole("button", { name: /(send|envoyer)/i })` fallback `[data-testid="send-button"]`.
  - `assistantBubble` → `[data-message-author-role="assistant"]`.
  - `streamingFlag` → `[data-message-streaming]` attribute on bubble.
  - `modelPicker` → `[data-testid="model-switcher"]`.
  - `webSearchToggle` → `[data-testid="composer-tool-web-search"]` fallback `getByRole("button", { name: /(search|recherche)/i })` inside the composer toolbar.
  - `accountMenu` → `[data-testid="profile-button"]`.
- B3. `src/browser/session.ts`:
  - `openSession({ headed }) → { context, page, close() }` using `chromium.launchPersistentContext(profileDir, { headless: !headed, viewport: { width: 1280, height: 900 }, args: ["--disable-blink-features=AutomationControlled"] })`.
  - Single shared `Page` per session.
- B4. `src/browser/chatgpt.ts` v0:
  - `goHome(page)` → `page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" })`.
  - `isLoggedIn(page)` → returns true if `accountMenu` selector resolves within 5 s.
  - Lock file (`profile/.cgpro-lock`) to prevent concurrent runs.
- B5. `src/cli/commands/login.ts`:
  - Open headed session, `goHome`, poll `isLoggedIn` every 2 s for up to 5 min.
  - On success: print `✓ Logged in as <email>` (read via `/api/auth/session`).
  - On timeout: error 7.
- B6. `src/cli/index.ts` — Commander shell with `login` only, `--version`, `--help`.
- B7. `pnpm build && node dist/cli/index.js login --help` works.
- B8. **Manual smoke**: `node dist/cli/index.js login` — author signs in to their real account, profile dir populates.
- B9. Commit: `feat(browser): persistent profile + login command`.

## Phase C — Read-only API helpers (~10 min)

- C1. `src/api/session.ts` — `getSession(page)` does `page.context().request.get("/api/auth/session")` → `{ accessToken, user, expires }`.
- C2. `src/api/me.ts` — `getMe(page)` → `/backend-api/me` (account, plan, features).
- C3. `src/api/models.ts` — `listModels(page)` → `/backend-api/models?history_and_training_disabled=false` → filter to `models[].slug`.
- C4. `src/cli/commands/status.ts` — prints `Email: …  Plan: …  GPT-5.5 Pro: ✓/✗`.
- C5. `src/cli/commands/models.ts` — table of available models with descriptions, marks the default.
- C6. **Smoke**: `cgpro status` and `cgpro models`.
- C7. Commit: `feat(api): read-only helpers + status/models commands`.

## Phase D — Ask command, end-to-end (~45 min)

This is the centerpiece.

- D1. `src/browser/chatgpt.ts` v1:
  - `openConversation(page, { model, conversationId? })` — navigates to `?model=…&temporary-chat=false` or `/c/<id>`, waits for composer.
  - `setWebSearch(page, on)` — clicks the toggle until its `aria-pressed` matches.
  - `setModel(page, model)` — opens `modelPicker`, clicks the matching item; idempotent.
  - `attachImages(page, paths[])` — `setInputFiles` on the hidden file input next to composer.
  - `sendPrompt(page, text)` — fills composer (preserve newlines via `\n` Shift+Enter sequence), clicks send.
  - `streamAssistant(page) → AsyncIterable<delta>`:
    - inject a one-shot `MutationObserver` via `page.evaluate` into the page that watches the latest assistant bubble's `innerText` and pushes diffs through `window.__cgproEmit(payload)`.
    - expose a binding `await page.exposeBinding("__cgproEmit", (_, payload) => emitter.push(payload))`.
    - resolve when `data-message-streaming="false"` AND a new `assistant-action-bar` button is visible.
  - `extractMarkdown(page)` — clicks the bubble's "Copy" affordance, reads `await page.evaluate(() => navigator.clipboard.readText())`. If clipboard permission missing, falls back to `bubble.innerText`.
  - `currentConversationId(page)` — parses `/c/<uuid>` from `page.url()`.
- D2. `src/core/orchestrator.ts`:
  - `ask({ prompt, model, web, images, system, resume?, save?, timeout })` →
    1. `openSession` headless.
    2. `openConversation` (resume or fresh).
    3. `setModel` + `setWebSearch` + (for `system`, send a first turn `"[CGPRO_SYSTEM]\n<text>"` — ChatGPT-side custom instructions are global, so we just stuff a "you are X" message at the top of the conversation if it's fresh).
    4. `attachImages`, `sendPrompt`, iterate `streamAssistant`, render via `renderMarkdown` (or NDJSON).
    5. `extractMarkdown` final, `currentConversationId`, `threads.save` if requested.
- D3. `src/core/render/markdown.ts` — incremental MD render: each delta is appended to a running buffer; we re-render the **last paragraph only** through `marked-terminal` to keep latency low. Falls back to plain text if `--no-color`.
- D4. `src/core/render/progress.ts` — ora spinner `"Thinking…"` until first delta, then stops.
- D5. `src/cli/commands/ask.ts` — wires Commander → orchestrator. Reads stdin if not TTY, appends to prompt. Computes exit code.
- D6. **Smoke**: `cgpro ask "what model are you, in 5 words?"` — observe streaming.
- D7. **Smoke**: `cgpro ask --web "what's the top story on hacker news right now?"` — verify web search activates.
- D8. **Smoke**: `cgpro ask --json "ping"` — assert NDJSON shape.
- D9. Commit: `feat(ask): end-to-end one-shot prompt with web search and image attach`.

## Phase E — Threads (~15 min)

- E1. `src/store/threads.ts` — `load()`, `save({...})`, `find(nameOrId)`, `remove(...)`, atomic write via temp+rename.
- E2. `src/cli/commands/thread.ts` — sub-commands `list|show|resume|rm|rename|save`.
- E3. `--save <name>` and `--resume <name>` plumbed through orchestrator.
- E4. **Smoke**: ask + save, then `cgpro thread list`, then `cgpro chat --resume <name>` (chat lands in Phase F but we can already navigate via `ask --resume`).
- E5. Commit: `feat(threads): persistent named conversations`.

## Phase F — Chat REPL (~20 min)

- F1. `src/cli/commands/chat.ts`:
  - Open one session+page+conversation, **kept alive across turns**.
  - REPL loop with `prompts` (multi-line via Shift+Enter, submit on bare Enter).
  - Built-in commands: `:save <name>`, `:web on|off`, `:model <id>`, `:reset`, `:thread`, `:quit` / Ctrl+D.
  - Each turn re-uses `streamAssistant` from Phase D (no nav).
- F2. Graceful shutdown on SIGINT: closes the browser cleanly.
- F3. **Smoke**: 3-turn conversation, `:save`, `:reset`, `:quit`.
- F4. Commit: `feat(chat): interactive REPL preserving the open page across turns`.

## Phase G — Stability + polish (~30 min)

- G1. `src/errors.ts` — typed errors + `mapToExitCode()`.
- G2. Wrap every command in a top-level handler that maps thrown errors → exit code + friendly message + log path.
- G3. `src/cli/commands/doctor.ts` — for each selector in `selectors.ts`, navigate, assert it resolves, print a table; flags broken ones.
- G4. `src/cli/commands/logout.ts` — confirms, then `rm -rf` profile.
- G5. Logging: pino-style JSON logs to `~/.cgpro/logs/YYYY-MM-DD.log` (rotated daily). Default level `warn`, `--debug` flips to `debug`.
- G6. README — install, login, ask, chat, troubleshooting, security note.
- G7. Vitest unit tests for `paths`, `threads`, `selectors` resolution against fixture HTML.
- G8. CI: GitHub Actions workflow runs `pnpm build && pnpm test && pnpm lint` on push.
- G9. Commit: `feat(stability): doctor, logout, structured logs, tests, CI`.

## Phase H — Release (~10 min)

- H1. `pnpm version 0.1.0` (no publish yet — private repo).
- H2. `gh release create v0.1.0` with notes pointing to spec + plan.
- H3. README final pass; troubleshooting section based on smoke findings.
- H4. Commit + push.

## Risks / mitigations during build

| Risk                                                                | Mitigation                                                                                          |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Selector for composer / send button drifts                          | Localized in `selectors.ts`, doctor command, fall-back chain                                        |
| Cloudflare challenge in headless mode                               | Always launch with the same profile that was warmed up headed; `--headed` escape hatch              |
| `gpt-5-5-pro` slug actually different (e.g. `gpt-5.5-pro`)          | `setModel` matches by visible text in the picker, not slug; deep-link is a hint only                |
| Web search toggle name varies by locale                             | Selector chain matches both EN and FR labels                                                        |
| Streaming chunks too small → terminal spam                          | Markdown renderer batches per paragraph                                                             |
| Long thinking phase (>2 min) before first delta                     | Spinner stays up; default `--timeout 600`                                                           |
| Image attach path on Windows                                        | Resolve to absolute path before `setInputFiles`                                                     |
| `navigator.clipboard.readText()` blocked headlessly                 | Bubble `innerText` is the always-available fallback                                                 |
| `chromium.launchPersistentContext` second instance crashes the lock | `profile/.cgpro-lock` PID file, friendly "another cgpro is running" error                           |

## Done-criteria

- `cgpro login` followed by `cgpro ask "ping"` returns a streamed answer in under 5 s end-to-end (after warm-up).
- `cgpro ask --web "today's date in <city>"` answers with sourced live data.
- `cgpro chat` runs ≥ 3 turns sharing context.
- `cgpro thread list/save/resume` round-trips.
- All commits pushed to `origin/main`, tagged `v0.1.0`, README documents install + first run.

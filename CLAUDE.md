# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build / test / dev

```bash
npm run build      # tsc → dist/
npm run dev        # tsx src/cli/index.ts (no build needed)
npm test           # vitest run (20 tests, ~1s)
npm test -- test/sse.test.ts        # single test file
npm test -- -t "parses simple"      # single test by name
npm run test:live  # CGPRO_LIVE=1 — requires a signed-in profile
npm run audit:selectors             # checks SELECTORS against live DOM
```

After source changes, **`npm run build` is required** before `cgpro <cmd>` reflects them — the global `cgpro` is `npm link`ed to `dist/cli/index.js`. For fast iteration use `npm run dev -- <cmd>`.

## Architecture

cgpro drives a real Chromium against `chatgpt.com` to expose GPT-5.5 Pro from the shell. Three execution modes share the same browser pipeline:

```
src/cli/commands/{ask,chat,daemon-server}.ts
        │
        ▼
src/core/orchestrator.ts          # one `runAsk` flow shared by all modes
        │
        ├──► src/browser/session.ts          # patchright launchPersistentContext
        ├──► src/browser/conversation.ts     # openConversation, sendPrompt, waitTurnComplete
        ├──► src/core/stream.ts              # SSE interceptor + parser (binding lives at context level)
        └──► src/api/{me,models,projects,conversations}.ts   # JSON over backendApiFetch
```

Daemon mode (`src/daemon/`) wraps `runAskOnSession` so multiple turns reuse one warm browser via HTTP+SSE on `127.0.0.1`. `cgpro ask` auto-detects the daemon (`getLiveDaemon()`) and routes through it.

ChatGPT Projects are mirrored via local `~/.cgpro/projects.json` mapping cwd → gizmo. `cgpro ask` auto-detects the linked project (`resolveLocalProject()`), navigates to `/g/<short-url>/project` BEFORE `sendPrompt` (the React app picks up the gizmo from the URL and creates the conv inside it), and prepends `~/.cgpro/projects/<gizmoId>/memory.md` as a preamble.

## Non-obvious gotchas (each cost real debugging time)

- **Auth requires Bearer JWT, not cookies.** `/backend-api/me` returns the anonymous device id `ua-XXX` when called WITHOUT `Authorization: Bearer <accessToken>` — even for fully signed-in sessions. Use `backendApiFetch(page, url)` (in `src/browser/chatgpt.ts`); it pulls the Bearer from `/api/auth/session` (cookies-only call) automatically. Never call `fetch('/backend-api/...')` directly from `page.evaluate` — you'll silently get anonymous data.

- **`/api/auth/session` is THE auth signal.** `isLoggedIn` checks `session.user.id?.startsWith('user-')`. Cookie presence is NOT sufficient — anonymous trial mode sets `__Secure-next-auth.session-token` too.

- **Background is default-on.** `openSession()` parks Chromium off-screen + minimised. The user wants cgpro to be transparent. `cgpro login` is the only command that forces visibility (user must interact). Set `CGPRO_NO_BACKGROUND=1` for debugging.

- **Web search is policy-on.** `--no-web` and `opts.web === false` are accepted by Commander but **ignored** with an "ignored — policy" stderr notice. `setWebSearch(page, true)` opens the "+ Tools" popover when the inline toggle isn't visible (recent chatgpt.com layout) and warns loudly to stderr if it can't enable.

- **Daemon holds the profile lock.** `assertNoDaemon(commandName)` is at the top of every cold-start command (`status`, `models`, `doctor`, `adopt`, `login`, `logout`, `chat`, `thread sync`, `project *`). Skipping it gets you `ProfileLockedError`. Only `cgpro ask` (HTTP) and `cgpro thread list` (cache) coexist with a running daemon.

- **`--no-X` flags via Commander.** `--no-daemon` populates `opts.daemon = false`, NOT `opts.noDaemon = true`. Check `opts.daemon !== false`. Same trap on `--no-project`, `--no-web`.

- **DOM selectors are in ONE file.** `src/browser/selectors.ts` is the only file with chatgpt.com selectors. Each entry is an ordered fallback list. When chatgpt.com changes, run `cgpro doctor` — the first `✖` points at the broken selector. Patch the first entry; the existing fallbacks are usually still valid.

- **Patchright, not playwright.** We use [`patchright`](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) (drop-in stealth fork) because Cloudflare flags vanilla Playwright/CDP signatures on chatgpt.com. Don't add `playwright` to dependencies — type conflicts.

- **Bundled Chromium, not system Chrome.** `chromium.launchPersistentContext(dir, { channel: undefined, ... })`. `channel: "chrome"` collides with the user's running Chrome on Windows.

- **Turn completion = text stability.** `waitTurnComplete` polls the latest assistant bubble's `innerText` every 400ms; "done" = no change for `stableMs` (default 4000ms, env-tunable via `CGPRO_STABLE_MS`). The legacy `data-message-streaming` attribute is gone. The "Stop generating" button (when present) resets the stability window — that's the only thing covering long mid-stream pauses on Pro extended-thinking turns.

- **Long turns (>10 min).** GPT-5.5 Pro can run >1 hour for hard problems. Default `cfg.timeoutSec` is 7200 (2h). Daemon clamps to 14400 (4h). Node `http.Server` timeouts are set to `0` in the daemon so SSE streams aren't killed mid-flight. Claude Code Bash tool tops out at 10 min — slash commands `/cgpro:ask` etc. MUST use `run_in_background: true` + BashOutput polling for any prompt that might be slow.

- **SSE binding lives at context level.** `setActiveEmitter(context, emitter)` swaps which emitter the `__cgproChunk`/`__cgproDone` bindings route to. The interceptor (in `addInitScript`) is registered ONCE per BrowserContext. Per-turn we just swap the emitter. Reset to `null` after turn so stale bindings don't leak in daemon mode.

- **Conversation id sources, in priority order.** (1) URL match `/c/<uuid>`, (2) SSE `started` event payload (`conversation_id`), (3) DOM. `currentConversationId(page)` only handles #1.

- **`/backend-api/me` (with Bearer) returns plan in `orgs.data[0].settings`** — not at the top level. `detectPlan()` falls back to feature/group sniffing.

- **Project creation has no public endpoint.** POST `/backend-api/gizmos` produces a Custom GPT (`g-` prefix), NOT a Project (`g-p-` prefix). `kind`/`type` body fields are ignored. `cgpro project create` prints UI instructions; auto-create needs network capture from the chatgpt.com sidebar's "+ New project" click.

- **Project / GPT terminology.** Internally OpenAI calls both "gizmos" — Projects have `g-p-` id prefix, Custom GPTs have bare `g-`. The `/backend-api/gizmos/snorlax/sidebar` response mixes both.

## Local state layout

```
~/.cgpro/
├── profile/                          # Chromium user-data-dir (cookies, IndexedDB)
├── threads.json                      # named bookmarks
├── conversations-cache.json          # snapshot of chatgpt.com sidebar
├── projects.json                     # cwd → gizmo mapping
├── projects/<gizmoId>/memory.md      # per-project memory (canonical)
├── session.json                      # 30-min shell-session anchor
├── daemon.json                       # daemon pid + port + token (mode 0600)
├── config.json                       # user defaults (defaultWeb, defaultHeadless, …)
└── logs/daemon.log
```

## Plugin layout

This repo doubles as a Claude Code plugin marketplace. Plugin assets live at the repo root (NOT inside a subdirectory):

- `.claude-plugin/{plugin,marketplace}.json`
- `commands/*.md` → `/cgpro:ask`, `/cgpro:chat`, `/cgpro:thread`, `/cgpro:project`
- `agents/gpt55-pro.md`
- `skills/cgpro/SKILL.md` (also installable into Codex via `cp -r skills/cgpro ~/.codex/skills/cgpro`)

When bumping plugin version: update **both** `.claude-plugin/plugin.json` AND `package.json` AND `src/version.ts`. Mismatch causes confusing `claude plugin list` output.

## When working in this repo

- **`cgpro project list` should show this repo as linked** (the cwd is `github.com/yannabadie/cgpro4code`, the canonical git remote). Conversations from `cgpro ask` here land in the linked project, not Recents.
- The probe script at `scripts/probe-projects.ts` is the diagnostic for backend API drift. Add candidate endpoints to its array, run `npx tsx scripts/probe-projects.ts`, read the schema-leak from 422 responses.
- `scripts/check-cookies.ts` dumps what cookies + auth state our profile actually carries — first stop when "logged-in UI but anonymous API" symptoms reappear.

## Commit conventions

`feat(scope):`, `fix(scope):`, `chore:`, `docs:`. Co-authored-by trailer is auto-appended by the harness — don't add manually. Never amend; always new commits. Pre-commit hooks must pass; never `--no-verify`.

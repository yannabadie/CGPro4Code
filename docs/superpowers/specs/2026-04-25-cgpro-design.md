---
name: cgpro CLI design
description: CLI client that drives a real Chromium against chatgpt.com to expose GPT-5.5 Pro (extended thinking + web search) from the terminal, using the user's existing ChatGPT Pro subscription
type: spec
date: 2026-04-25
---

# `cgpro` — ChatGPT Pro from the CLI

## 1. Problem

A ChatGPT Pro subscriber wants to ask questions in the terminal, targeting:

- **Model:** `GPT-5.5 Pro` (the highest-accuracy variant, reserved to Pro/Business/Enterprise tiers).
- **Reasoning:** extended thinking (built into GPT-5.5 Pro by default).
- **Web access:** live internet search, with sources.

As of April 25, 2026:

- The OpenAI **public API does not expose `gpt-5.5-pro`** ("API deployments require different safeguards […] coming to the API soon").
- The **Codex CLI / `/backend-api/codex/responses`** endpoint exposes `gpt-5.5` and lower variants via the ChatGPT subscription, but **not `gpt-5.5-pro`** (Codex is coding-agent oriented and serves the standard Thinking model only).
- The only place `gpt-5.5-pro` lives is the **consumer ChatGPT app** (web at `chatgpt.com`, native macOS/Windows clients) bound to the subscription.

The user wants this in CLI — so the only path is to drive the consumer ChatGPT product from a terminal.

## 2. Goals & non-goals

### Goals

- Send a prompt to `gpt-5.5-pro` (with extended thinking) from the shell and stream the answer to stdout.
- Toggle live web search per prompt.
- Multi-turn conversations, persistable and resumable.
- One-time login; subsequent runs are zero-friction.
- Stable face to anti-bot evolution: do not reimplement OpenAI's proof-token / Cloudflare Turnstile algorithms.
- Cross-platform (Windows / macOS / Linux), `npm i -g` install.

### Non-goals

- No commercial resale, no high-volume scraping, no bypass of OpenAI ToS. The tool re-uses the user's own subscription, the same way the official desktop app does.
- No backwards-compat with the OpenAI public Responses API surface (we are not a drop-in `openai` SDK).
- No support for non-Pro models (Codex backend already covers those — out of scope).
- No GUI.

## 3. Constraints

- ChatGPT Pro is `$200/mo` and rate-limited per account. The CLI must not amplify load (one in-flight request at a time per session).
- `chatgpt.com` is protected by Cloudflare + OpenAI sentinel (proof token, Turnstile). Pure HTTP clients break weekly. Only a real browser session is durable.
- ChatGPT Pro requests can be long (extended thinking can run several minutes). Streaming and timeouts must accommodate this.
- The user runs Windows 11 + Node 24 + Python 3.13. Stack must work on all three OS.

## 4. Architecture

Single Node.js + TypeScript CLI. One Chromium browser per process, in `launchPersistentContext` mode against a **dedicated profile** stored in `~/.cgpro/profile/`. The profile holds cookies, localStorage, IndexedDB — i.e. the full logged-in session. The browser is started **headed for `cgpro login`** (so the user can sign in and clear any 2FA/Turnstile interactively) and **headless** for everything else.

```
┌───────────────┐         ┌─────────────────────────────────┐
│  cgpro CLI    │  spawn  │ Chromium (persistent profile)   │
│  (Commander)  ├────────▶│ → chatgpt.com (already logged)  │
└──────┬────────┘         │   composer / model picker / ws  │
       │                  └─────────────────────────────────┘
       │ markdown stream
       ▼
   stdout
```

The CLI never makes raw HTTP calls to `chatgpt.com/backend-api/...` itself. All requests are issued **from inside the page** via `page.context().request` (which inherits cookies & headers) or by **driving the page UI** for anything that needs the proof-token (the page's own JS computes it transparently).

### 4.1 Modules

```
src/
├── cli/
│   ├── index.ts            # commander entrypoint, banner, version
│   └── commands/
│       ├── login.ts        # headed Chromium, wait for logged-in state
│       ├── ask.ts          # one-shot prompt → stream → exit
│       ├── chat.ts         # interactive REPL (prompts pkg)
│       ├── thread.ts       # list / show / resume / rm
│       ├── status.ts       # session health + model availability
│       └── logout.ts       # wipe profile
│
├── browser/
│   ├── session.ts          # launchPersistentContext lifecycle, profile path
│   ├── chatgpt.ts          # high-level driver: openHome, selectModel,
│   │                       #   toggleWebSearch, sendPrompt, streamResponse
│   └── selectors.ts        # ALL DOM selectors (single source of UI truth)
│
├── api/
│   ├── session.ts          # GET /api/auth/session  → access JWT
│   ├── me.ts               # GET /backend-api/me   → account + tier
│   └── models.ts           # GET /backend-api/models → list with `gpt-5-5-pro`
│
├── core/
│   ├── orchestrator.ts     # ask(prompt, opts): browser → stream
│   ├── stream.ts           # async iterator of {delta, role, done}
│   └── render/
│       ├── markdown.ts     # marked + marked-terminal
│       └── progress.ts     # ora spinner, "thinking…" indicator
│
├── store/
│   ├── paths.ts            # ~/.cgpro/{profile,threads,config.json}
│   ├── threads.ts          # local mapping name ↔ chatgpt.com thread URL
│   └── config.ts           # default model, default --web, etc.
│
├── errors.ts               # typed errors (NotLoggedInError, ProTierRequired…)
└── version.ts
```

### 4.2 Login flow

1. `cgpro login` launches Chromium **headed** with `userDataDir = ~/.cgpro/profile`.
2. Navigate to `https://chatgpt.com/`.
3. Wait for either:
    - the cookie `__Secure-next-auth.session-token` (or its equivalent) to appear, **and**
    - `GET /api/auth/session` to return a JSON body containing `accessToken` + `user.email`,
    - **or** a 5-minute timeout.
4. On success: print "Logged in as <email> (<plan>)", close.
5. The profile directory is now self-sufficient — no token files for us to manage; Chromium handles refresh.

### 4.3 Ask flow

1. Launch Chromium headless against the same profile.
2. Navigate to `https://chatgpt.com/?model=gpt-5-5-pro&temporary-chat=false` (or current equivalent).
3. Optionally append `&tools=web_search` deep-link **or** click the web-search toggle in the composer toolbar — whichever the live UI exposes.
4. If `--resume <thread>` was given: `goto https://chatgpt.com/c/<conversation_uuid>` instead.
5. Fill the composer (`getByRole("textbox", { name: /message/i })`) with the prompt; for piped stdin, fill the body; for `--image`, drop the file via `setInputFiles`.
6. Submit (`getByRole("button", { name: /send/i })` or `Enter`).
7. **Stream the response** by observing the new `[data-message-author-role="assistant"]` bubble:
    - Watch for the `data-message-streaming="true"` → `false` transition.
    - Read the bubble's `innerText` on every mutation (MutationObserver running in the page) — emit deltas to stdout.
8. Once `data-message-streaming="false"` and the "regenerate" button is clickable: extract final markdown via the bubble's "Copy" action (which puts clean MD on the clipboard) — fall back to innerText if Copy is unavailable.
9. Capture the new conversation UUID from the URL (`/c/<uuid>`); if `--save <name>` was passed, store it in `threads.json`.
10. Close the page; keep the context alive for the rest of the process.

### 4.4 Chat flow (REPL)

- One persistent browser context, one open page.
- Each user turn re-uses the same page (no nav between turns), so context stays warm.
- `Ctrl+D` exits, `:save <name>` saves the thread, `:web on/off` toggles per-turn, `:reset` opens a new conversation.

### 4.5 Stream protocol (CLI ↔ user)

Default: pretty-printed markdown via `marked-terminal`, with a leading `ora` spinner labelled `Thinking…` until the first delta arrives, then replaced by the stream.

`--json`: NDJSON events on stdout, one per line:

```jsonl
{"type":"started","model":"gpt-5-5-pro","conversation_id":"abc","web":true}
{"type":"delta","text":"The capital of France"}
{"type":"delta","text":" is Paris."}
{"type":"sources","items":[{"title":"...","url":"..."}]}
{"type":"done","tokens":{"in":42,"out":128},"latency_ms":12345}
```

`--no-stream`: buffer everything, print the final markdown once.

## 5. Key design choices

### 5.1 Why drive the page UI instead of POSTing to `/backend-api/conversation`?

Hitting the JSON API directly requires producing a valid `openai-sentinel-chat-requirements-token` *and* `openai-sentinel-proof-token` *and* sometimes a Turnstile token. These are computed by `chatgpt.com`'s own JavaScript (workproof PoW, fingerprinting, etc.) and the algorithm changes monthly. Driving the composer means **OpenAI's own JS produces these tokens for us**, so the implementation stays stable across changes.

The cost is ~200 ms of UI overhead per turn — irrelevant for a ChatGPT Pro session that runs for tens of seconds.

### 5.2 Why a single global profile (not per-thread)?

ChatGPT's session, custom instructions, memory, and conversation history all live in the account. A second profile would mean a second login and a second account view. We mirror the desktop app's "one profile, many threads" model.

### 5.3 Why headless after login?

`launchPersistentContext` keeps the same WebGL/font/UA fingerprint, the same cookies, and the same IndexedDB across headed/headless launches. Cloudflare doesn't re-challenge a recently-validated profile. So the user pays the headed cost once.

### 5.4 Selector strategy

All `getByRole` / `getByTestId` calls live in `browser/selectors.ts`. When OpenAI ships a UI change, we patch one file. Each selector has a short comment naming its function (e.g. `// composer textarea (chatgpt.com Apr 2026)`).

We also ship a `cgpro doctor` subcommand (P2) that runs a tiny health-check script and reports which selector is broken, so users can file an actionable bug.

### 5.5 Concurrency

One in-flight prompt at a time per process. `ask` is fire-and-forget; `chat` enforces it via a turn lock. No parallelism — ChatGPT Pro itself serializes requests per account.

## 6. Local state

```
~/.cgpro/
├── profile/          # Chromium user data dir (cookies, IndexedDB, …)
├── threads.json      # { "<name>": "<chatgpt-conversation-uuid>" }
├── config.json       # { defaultModel, defaultWeb, headless, … }
└── logs/
    └── YYYY-MM-DD.log
```

Threads.json schema:

```json
{
  "threads": [
    {
      "name": "kubernetes-deep-dive",
      "id": "8f3c2d…",
      "model": "gpt-5-5-pro",
      "title": "K8s networking model",
      "created_at": "2026-04-25T12:00:00Z",
      "updated_at": "2026-04-25T12:34:56Z"
    }
  ]
}
```

## 7. CLI surface

```
cgpro login                               # one-time, opens Chromium headed
cgpro logout                              # wipes ~/.cgpro/profile
cgpro status                              # session health + tier + models
cgpro models                              # list models the account has access to

cgpro ask "<prompt>" [opts]               # one-shot
cgpro chat [--resume <name|id>]           # interactive REPL

cgpro thread list
cgpro thread show <name|id>
cgpro thread resume <name|id>             # opens chat REPL on that thread
cgpro thread rm <name|id>
cgpro thread rename <old> <new>
cgpro thread save <id> <name>             # save the current thread under a name

cgpro doctor                              # selector health-check
```

### Common options

| Flag                      | Default            | Notes                                                                |
| ------------------------- | ------------------ | -------------------------------------------------------------------- |
| `--model <id>`            | `gpt-5-5-pro`      | Any model the account has access to                                  |
| `--web` / `--no-web`      | `--web` (on)       | Live internet search                                                 |
| `--headed` / `--headless` | `--headless`       | Force browser visibility                                             |
| `--image <path>`          | —                  | Attach an image (repeatable)                                         |
| `--system "<text>"`       | —                  | Custom Instructions for this turn (uses ChatGPT's "system" override) |
| `--json`                  | off                | NDJSON event stream                                                  |
| `--no-stream`             | off                | Buffer until done                                                    |
| `--save <name>`           | —                  | Persist this conversation under a name                               |
| `--timeout <secs>`        | 600                | Max wait for the model to finish a turn                              |
| `--profile <path>`        | `~/.cgpro/profile` | Override profile dir (multi-account)                                 |

stdin: if not a TTY, its contents are appended to the prompt (so `cat foo | cgpro ask "review"` works).

## 8. Error handling

| Error                | Exit code | Message                                                            |
| -------------------- | --------- | ------------------------------------------------------------------ |
| Not logged in        | `2`       | "No active ChatGPT session. Run `cgpro login`."                    |
| Profile locked       | `3`       | "Another `cgpro` is using the profile. Wait or `--profile` other." |
| Model unavailable    | `4`       | "Your plan does not include `<model>`. Try `cgpro models`."        |
| Selector broken      | `5`       | "ChatGPT UI changed. Run `cgpro doctor` and file a bug."           |
| Network / timeout    | `6`       | "Timed out after Ns. Try `--timeout` higher."                      |
| Cloudflare challenge | `7`       | "Bot check triggered. Run `cgpro login --headed` to refresh."      |

Every error includes a `--debug` traceback path under `~/.cgpro/logs/`.

## 9. Stability & maintenance plan

- **Smoke suite** in `test/smoke/` exercises only login-detection logic against a static HTML fixture (no live network).
- **Live-test runner** (`pnpm test:live`) opt-in: requires `CGPRO_LIVE=1`, runs `ask "say 'pong'"` against the user's real account.
- **Selector audit script** (`pnpm audit:selectors`) navigates to chatgpt.com, asserts every selector resolves to ≥1 element, prints a table.
- **One file = one UI surface**: `browser/selectors.ts` is the *only* place that knows DOM details.
- **Versioning**: SemVer; major bumps when chatgpt.com requires breaking changes.

## 10. Out-of-scope today, deferred

- Voice input/output.
- Image generation prompts (DALL-E / Sora) — would need to harvest the rendered image URL.
- Canvas / artifact extraction — same (deferred).
- Multi-account support beyond `--profile`.
- TUI (the REPL is line-based, not full-screen).

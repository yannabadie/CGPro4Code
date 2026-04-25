# cgpro

> **ChatGPT Pro from your terminal** — drives a real Chrome session against
> `chatgpt.com` so you can use **GPT-5.5 Pro** (extended thinking + live web
> search) from the shell, with your existing ChatGPT Pro subscription.

```
$ cgpro ask --web "what's the top story on Hacker News right now, in 2 lines?"
Thinking…
gpt ▸ The current top story on HN is "OpenAI ships GPT-5.5 Pro to API"
       (892 points), discussing the just-announced API rollout and pricing.
```

## Why this exists

As of April 2026:

- **GPT-5.5 Pro** lives only in the consumer ChatGPT app (web + mobile). It is
  not in the public OpenAI API yet, and **not** exposed by the official Codex
  CLI either (which serves the standard `gpt-5.5` Thinking model).
- The only practical way to script `gpt-5.5-pro` from a terminal is to drive
  the same UI a logged-in user would.

`cgpro` does that, via **Playwright + a real Chrome instance with a persistent
profile**. You log in once with `cgpro login`; every subsequent `ask` or
`chat` reuses the same session. Cloudflare/sentinel anti-bot tokens are
produced by the page's own JavaScript — we don't reimplement them, which is
what makes this approach **stable** across OpenAI's frequent backend changes.

## Install

Requirements: Node.js ≥ 20 and Chrome (or Chromium) installed.

```bash
git clone https://github.com/yannabadie/CGPro4Code.git cgpro
cd cgpro
npm install
npx playwright install chromium    # bundled fallback if Chrome is missing
npm run build
npm link                           # installs the `cgpro` command globally
```

(or run from the repo with `node dist/cli/index.js …`.)

## First run

```bash
cgpro login
```

A Chrome window opens at `chatgpt.com`. Sign in (handle 2FA / Cloudflare if
needed). Once the chat home is visible the command exits with `✔ Logged in`.

```bash
cgpro status
# Account:      you@example.com
# Plan:         pro
# Token until:  …
# Models:       17 available
# GPT-5.5 Pro:  ✓ (slug: gpt-5-5-pro)
```

## Usage

### One-shot prompt

```bash
cgpro ask "explain CRDTs in 3 bullet points"
cgpro ask --web "today's weather in Lyon"
cgpro ask --no-web "give me a strict TypeScript type for ISO-8601 dates"
cgpro ask -i diagram.png "explain this architecture"
echo "review this code" | cgpro ask < src/api/me.ts
cgpro ask --json "ping" | jq .
```

### Interactive chat

```bash
cgpro chat
# you ▸ what's the safest way to migrate a 50M-row table to add a NOT NULL column?
# gpt ▸ …
# you ▸ :web off
# you ▸ :save db-migrations
# you ▸ :quit
```

Built-in slash commands:

| Command          | Effect                                                  |
| ---------------- | ------------------------------------------------------- |
| `:web on/off`    | Toggle live web search                                  |
| `:model <slug>`  | Switch model (resets the conversation)                  |
| `:reset`         | Start a fresh conversation                              |
| `:save <name>`   | Persist the current conversation under a name           |
| `:thread`        | Show the current chatgpt.com conversation UUID          |
| `:quit` / Ctrl+D | Exit                                                    |

### Threads

```bash
cgpro thread list
cgpro thread show db-migrations
cgpro thread save <uuid> mybranch     # adopt an existing chatgpt.com thread
cgpro chat --resume db-migrations     # continue the saved thread
cgpro thread rm db-migrations
```

### Diagnostics

```bash
cgpro status      # session + plan + GPT-5.5 Pro detection
cgpro models      # list models the account has access to
cgpro doctor      # audit selectors against live chatgpt.com DOM
cgpro logout      # wipe the local profile
```

## Common flags

| Flag                      | Default            | Notes                                                      |
| ------------------------- | ------------------ | ---------------------------------------------------------- |
| `--model <slug>`          | `gpt-5-pro`        | Any slug from `cgpro models`                                |
| `--web` / `--no-web`      | `--web` (on)       | Live internet search                                        |
| `--headed` / `--headless` | headed             | Browser visibility — keep headed for max stability         |
| `--profile <path>`        | `<env>/cgpro/profile` | Multi-account: pass a different dir                     |
| `--resume <name|id>`      | —                  | Continue an existing conversation                           |
| `--save <name>`           | —                  | Persist this conversation                                   |
| `--timeout <secs>`        | `600`              | Max wait for the model to finish a turn                     |
| `--json`                  | off                | NDJSON event stream                                         |
| `--render`                | off                | Buffer + render markdown after stream completes             |
| `--no-stream`             | off                | Buffer until done, then print                               |

## Architecture

```
~/.cgpro/                   ← env-paths default location
├── profile/                ← Chromium user data dir (cookies, IndexedDB)
├── threads.json            ← name ↔ chatgpt.com UUID
└── config.json             ← user defaults (model, web, headless, …)
```

- **`src/browser/selectors.ts`** is the only file that knows DOM details.
  When chatgpt.com ships a UI change, patch this file. `cgpro doctor` audits
  it against the live page.
- **Streaming** is captured by injecting a fetch interceptor (`addInitScript`)
  that mirrors `/backend-api/conversation` SSE chunks into a Node binding.
  The page issues the real request — we shadow-stream it.
- **Composer** is driven via the page UI (typing into `#prompt-textarea`,
  clicking the send button) so OpenAI's own JS produces the proof tokens.

See [`docs/superpowers/specs/2026-04-25-cgpro-design.md`](docs/superpowers/specs/2026-04-25-cgpro-design.md)
for the full design doc and rationale.

## Stability

- Selectors have ordered fallback chains in `selectors.ts`.
- `cgpro doctor` is the first thing to run when something breaks.
- Unit tests (`npm test`) cover the SSE parser, the threads store, and selector
  shape integrity.
- Live smoke (`CGPRO_LIVE=1 npm run test:live`) is opt-in and exercises a real
  account — keep this disabled in CI by default.

## Compliance

This tool authenticates with **your own** ChatGPT subscription via the
official chatgpt.com login flow. It does **not** re-sell, scrape, or amplify
load. It is for personal CLI use only.

You are responsible for using the tool in line with:

- [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/)
- [OpenAI Usage Policies](https://openai.com/policies/usage-policies/)

For commercial / multi-user / high-volume needs, use the official
[OpenAI Platform API](https://platform.openai.com/) when GPT-5.5 Pro lands
there.

## License

MIT — see [LICENSE](./LICENSE).

# cgpro

**ChatGPT 5.5 Pro from your terminal.** Drives `chatgpt.com` with a real
Chrome session to expose **GPT-5.5 Pro** (extended reasoning + live web
search) using your existing ChatGPT Pro subscription.

```
$ cgpro ask --web "top story on Hacker News, in 2 lines"
gpt ▸ "OpenAI ships GPT-5.5 Pro to API" (892 pts) — discussion of the
       rollout and pricing announced this morning.
```

## Why this exists

As of April 2026, **GPT-5.5 Pro lives only in the ChatGPT app** (web +
mobile). The public OpenAI API does not expose it. Codex CLI does not
expose it. The only way to script it from a shell is to drive the same
UI a logged-in user clicks on. That is what `cgpro` does.

## Status

`v0.2.0` — works end-to-end on Windows. Core features stable; the
plugin packaging (Claude Code + Codex) and daemon mode are new in 0.2.

## Install

Prerequisites: **Node.js ≥ 20** and (optionally) the **ChatGPT desktop
app** signed in on this machine.

```bash
git clone https://github.com/yannabadie/CGPro4Code.git cgpro
cd cgpro
npm install
npm run build
npm link            # puts `cgpro` on your PATH
```

(The bundled Chromium is installed automatically by patchright on
`npm install`. No system Chrome required.)

## First run

Pick **one** of these two paths:

### A) Adopt the desktop app's session (recommended)

If you already have the ChatGPT desktop app installed and signed in on
this machine, the fastest path is to import its session into cgpro's
profile — no second sign-in required.

```bash
cgpro adopt --kill-app
```

This kills the desktop app (so the cookie database isn't locked),
copies its `Local State`, `Cookies`, IndexedDB, and friends into
`~/.cgpro/profile/Default/`, and verifies the resulting session is
authenticated.

### B) Sign in interactively

If you don't have the desktop app:

```bash
cgpro login
```

Chromium opens on `chatgpt.com`. Sign in (password, 2FA, Cloudflare if
needed). The browser auto-closes the moment authentication is detected.

### Verify

```bash
cgpro status
# Account:      you@example.com
# Plan:         pro
# GPT-5.5 Pro:  ✓
```

## Commands

| Command | Purpose |
|---|---|
| `cgpro adopt` | Import the desktop ChatGPT app's session. |
| `cgpro login` | Interactive sign-in via Chromium. |
| `cgpro logout` | Wipe the local profile (forces re-login). |
| `cgpro status` | Account, plan, model availability, GPT-5.5 Pro detection. |
| `cgpro models` | List models available to your subscription. |
| `cgpro ask "..."` | One-shot prompt; streams the answer. |
| `cgpro chat` | Multi-turn REPL. |
| `cgpro thread list / show / save / rm / rename` | Bookmark conversations by name. |
| `cgpro thread sync / list --remote` | Mirror your chatgpt.com sidebar locally. |
| `cgpro daemon start / stop / status` | Long-lived browser for instant first-token. |
| `cgpro doctor` | Audit selectors against the live DOM. |

## `ask`

```bash
cgpro ask "explain CRDTs in 3 bullets"
cgpro ask --web "weather in Lyon today"
cgpro ask --no-web "give me a strict TypeScript type for ISO-8601 dates"
cgpro ask -i diagram.png "explain this architecture"
echo "review this code" | cgpro ask < src/api/me.ts
cgpro ask --json "ping" | jq .
cgpro ask --save mybranch "..."   # bookmark the resulting thread
cgpro ask --resume mybranch "follow-up"
cgpro ask --new-session "totally unrelated question"
```

Successive `cgpro ask` calls in the same shell auto-continue the same
conversation for 30 minutes. `--new-session` skips the auto-resume.

## `chat` (REPL)

```bash
cgpro chat
# you ▸ ...
# gpt ▸ ...
# you ▸ :web off
# you ▸ :save db-migrations
# you ▸ :quit
```

Multi-line input: end a line with `\` to continue.

| Slash | Effect |
|---|---|
| `:web on/off` | Toggle live web search. |
| `:model <slug>` | Switch model (resets the conversation). |
| `:reset` | New conversation. |
| `:save <name>` | Bookmark the current conversation. |
| `:thread` | Print the chatgpt.com UUID. |
| `:quit` or `Ctrl+C` | Exit. |

## Daemon mode

Cold-starting Chromium adds 5-10s of latency to every `ask`. With the
daemon running, the first token arrives near-instantly and subsequent
turns reuse the warm browser:

```bash
cgpro daemon start         # spawn detached, returns once browser is warm
cgpro ask "first question"  # near-instant
cgpro ask "follow-up"
cgpro daemon status        # pid, uptime, current conversation, busy/idle
cgpro daemon stop          # graceful: POST /shutdown then SIGTERM if needed
```

`cgpro ask` and `cgpro chat` auto-detect the daemon. Pass `--no-daemon`
to force a cold start. The daemon binds to `127.0.0.1` only and
authenticates every request with a 256-bit token from `~/.cgpro/daemon.json`.

## Plugin: Claude Code

This repo doubles as a Claude Code marketplace. Add it once and the
`cgpro` CLI becomes available as a slash command, agent, and skill:

```bash
# In Claude Code:
/plugin marketplace add yannabadie/CGPro4Code
/plugin install cgpro@cgpro
```

Then:
- `/cgpro:ask <question>` — one-shot question to GPT-5.5 Pro
- `/cgpro:thread` — list / sync / show conversations
- The `gpt55-pro` agent — spawnable for second-opinion consultations
- The `cgpro` skill — auto-activates when the user asks for second
  opinions, deep reasoning, or web search

## Plugin: Codex (CLI)

Codex CLI uses the same `SKILL.md` format. Install the skill into your
Codex skills directory:

```bash
mkdir -p ~/.codex/skills
cp -r skills/cgpro ~/.codex/skills/cgpro
```

(or symlink it if you want the skill to track this checkout.)

Codex will discover the skill on next start and auto-activate it when
its description matches the user's intent.

## Local storage

```
~/.cgpro/
├── profile/                # Chromium user-data-dir (cookies, IndexedDB, …)
├── threads.json            # named bookmarks: { name → uuid }
├── conversations-cache.json  # snapshot of chatgpt.com sidebar
├── session.json            # 30-minute shell-session anchor
├── daemon.json             # daemon pid + port + token (mode 0600 on Unix)
├── config.json             # user defaults
└── logs/
    └── daemon.log
```

Nothing is sent anywhere except `chatgpt.com`.

## Threat model & ToS

- **Authentication.** `cgpro` reuses *your own* ChatGPT subscription via
  the official sign-in flow (or the desktop app's cookie jar). Same
  credentials, same session, same rate limits as the desktop app.
- **No automation framework leaks.** The browser uses
  [`patchright`](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)
  to defeat Cloudflare's Playwright/CDP detection, with a real
  on-disk Chromium profile (no headless fingerprint).
- **Data.** No telemetry. Profile + cookies stay local.
- **ToS.** This is personal CLI use. For production / multi-user
  workloads, use the [OpenAI Platform API](https://platform.openai.com)
  when GPT-5.5 Pro lands there. Do not use `cgpro` to redistribute
  ChatGPT outputs commercially or to violate OpenAI's [Usage Policies](https://openai.com/policies/usage-policies/).

## When it breaks

OpenAI ships UI changes regularly. If `cgpro ask` hangs:

```bash
cgpro doctor
```

The first `✖` points at the broken selector. Patch the corresponding
entry in `src/browser/selectors.ts` (the **only** file with DOM
selectors), rebuild, retry:

```bash
npm run build
cgpro ask "test"
```

For network-flow regressions (the SSE shape changes), set `CGPRO_DEBUG=1`
and re-run; the orchestrator dumps every state transition.

## Tests

```bash
npm test
```

Unit tests for the SSE parser, thread store, and selector integrity.
Selector tests are static; live-DOM verification is `npm run test:live`
(requires a signed-in profile).

## Internal docs

- Spec: [`docs/superpowers/specs/2026-04-25-cgpro-design.md`](docs/superpowers/specs/2026-04-25-cgpro-design.md)
- Plan: [`docs/superpowers/plans/2026-04-25-cgpro-implementation-plan.md`](docs/superpowers/plans/2026-04-25-cgpro-implementation-plan.md)

## License

MIT — see [LICENSE](./LICENSE).

---
name: cgpro
description: Use the local cgpro CLI to consult ChatGPT 5.5 Pro (extended thinking + live web search) AND to mirror the current Claude Code project into a ChatGPT Project so conversations land in the right folder with persistent project memory. Reach for this skill when the user wants a second opinion, deep reasoning, fresh web info, multi-turn chats, or wants to make a directory's GPT-5.5 conversations stay organised inside a named ChatGPT Project (auto-routed, with a memory.md that's prepended to every new chat).
---

# cgpro: ChatGPT 5.5 Pro from the terminal

`cgpro` is a CLI that drives the user's authenticated ChatGPT session
against `chatgpt.com` to expose **GPT-5.5 Pro** with extended thinking
and live web search — capabilities that are not exposed by the public
OpenAI API or by Codex CLI as of April 2026.

Use this skill when the user wants any of:

- A second opinion on a hard architectural / debugging question
- Extended reasoning on a problem that benefits from deliberation
- Live web search results with citations (current events, fresh docs)
- A multi-turn ChatGPT thread driven from the terminal

## How to call it

`cgpro` is a single binary on the user's `PATH`. All calls are plain
shell — use the `Bash` tool (or your platform equivalent) to run them.

### Single question

```bash
cgpro ask "your question"
```

Streams the answer to stdout. **Live web search is always on by
default** — that's a policy choice for this CLI, since freshness +
sources matter more than determinism for the use cases this tool
serves. Use `--json` for NDJSON event stream when you want to parse
programmatically.

### Multi-turn

`cgpro` auto-resumes the most recent shell-session conversation for
30 minutes, so back-to-back `cgpro ask` calls thread automatically.
For an explicit multi-turn REPL, use `cgpro chat`. For a clean slate,
pass `--new-session`.

```bash
cgpro ask "explain CRDTs in 3 bullets"
cgpro ask "now sketch a Rust trait for a state-based one"   # remembers
cgpro ask --new-session "totally different question"
```

### Resume a saved conversation

```bash
cgpro thread list                 # local saved bookmarks
cgpro thread list --remote --refresh   # the chatgpt.com sidebar
cgpro ask --resume <name|uuid> "follow-up"
cgpro ask --save <name> "..."     # save the resulting thread under a name
```

### Project routing (keep your Recents clean)

`cgpro` mirrors the current cwd into a ChatGPT Project so conversations
land there and out of the global Recents list. Identity is the git
remote (when present) or the cwd path.

```bash
cgpro project list              # remote projects + which one is linked here
cgpro project link "MyProj"     # link this cwd to an existing project
cgpro project show              # see linked project + recent convs + memory size
cgpro project digest            # ask GPT-5.5 to summarise recent convs into memory.md
cgpro ask "anything"            # auto-routes into the linked project,
                                # injects memory.md as preamble for new convs
cgpro ask --no-project "..."    # opt out of routing for one call
```

Project memory lives at `~/.cgpro/projects/<gizmoId>/memory.md` and is
appended (not overwritten) by `digest`.

### Speed: daemon mode

Cold-starting Chromium adds ~5-10s per call. Start the daemon once and
all subsequent asks use the warm browser:

```bash
cgpro daemon start    # one-time setup
cgpro ask "..."        # near-instant first token
cgpro daemon status
cgpro daemon stop
```

`cgpro ask` auto-detects the daemon. No client-side change needed.

## When NOT to use cgpro

- **Quick lookups Claude already knows.** Don't waste a Pro turn on
  trivial questions.
- **Tasks where the user wants Claude's own answer.** If they ask
  *you* to do something, do it. Don't reflexively bounce to GPT-5.5.
- **When `cgpro status` shows the user is not signed in.** Tell the
  user to run `cgpro login` (interactive) or `cgpro adopt` (imports
  the desktop app's session). Don't try to authenticate yourself.

## Health check

If `cgpro` returns `Not signed in`, `Cloudflare challenge`, or
`Selector broken`, surface the error to the user — those need
human intervention. For selector breakage, `cgpro doctor` audits
the live DOM and points at the broken selector.

## Conformance

`cgpro` uses the user's *own* ChatGPT subscription via the standard
sign-in flow — same credentials, same session, same rate limits as
the desktop app. Personal CLI use only.

---
description: Manage the ChatGPT Project linked to this cwd (list, link, show, digest).
argument-hint: [list|show|link <name>|unlink|digest]
---

Use the **cgpro** CLI to mirror the current working directory into a
ChatGPT Project so conversations land there instead of polluting the
user's Recents list.

## Steps

Resolve the user's intent from `$ARGUMENTS`, then run the matching
shell command via the `Bash` tool:

| Intent | Command |
|---|---|
| empty / `list` | `cgpro project list` — shows remote projects + which is linked here |
| `show [name]` | `cgpro project show [name]` — full details + recent convs |
| `link <name>` | `cgpro project link <name>` — link this cwd to an existing project |
| `unlink` | `cgpro project unlink` — remove the link |
| `digest` | `cgpro project digest` — summarise this project's recent convs into local memory |
| `create [name]` | `cgpro project create [name]` — prints UI instructions (auto-create not yet supported by the API) |

After running, parse the output and surface the relevant facts to the
user. For `digest`, mention how many chars were appended to the
project's `memory.md`.

## Why this matters

Once the cwd is linked, every `cgpro ask` and `/cgpro:ask` from this
directory automatically lands in the matching ChatGPT Project. The
project's local `memory.md` is also injected as a preamble to each
new conversation, so prior decisions and context carry over without
the user having to re-explain themselves.

## Failure modes

- `Project not found` → list with `cgpro project list`, then link by exact name.
- `Not signed in` → tell the user to run `cgpro login` (or `cgpro adopt`).
- `cwd not linked` (digest) → user must `cgpro project link` or `cgpro project create` first.

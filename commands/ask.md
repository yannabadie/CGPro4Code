---
description: Ask GPT-5.5 Pro a one-shot question (extended thinking + optional web search).
argument-hint: <question>
---

You will use the **cgpro** CLI to forward the user's question to
ChatGPT 5.5 Pro and present the answer in this conversation.

## Steps

GPT-5.5 Pro often takes **5-30 minutes** for non-trivial questions and
can run **over an hour** for hard reasoning. The Bash tool's per-call
ceiling is 10 minutes, so for any prompt that might be slow you MUST
use the background-job pattern.

### Fast path (likely <10 min)

```bash
cgpro ask --json --timeout 600 "$ARGUMENTS"
```

Parse NDJSON. Terminal `done` event carries `finalText`.

### Long path (likely >10 min — default for serious questions)

1. Start the request in the background with the Bash tool:
   - command: `cgpro ask --json --timeout 7200 "$ARGUMENTS" > "$TMPDIR/cgpro-$$.out" 2>&1`
   - `run_in_background: true`
   - capture the returned bash_id
2. Use the BashOutput tool with that bash_id to peek at progress every
   60-120 seconds. Watch for an NDJSON line whose `type` is `"done"`
   (success) or `"error"` (failure).
3. Once `done` arrives, parse `finalText` from that line and present
   it to the user.
4. If the user's question implied "I'll wait" / "deep analysis" /
   "review", default to the long path. If unsure, ask.

## Failure surfaces to relay

- `Not signed in` → `cgpro login` or `cgpro adopt`
- `Selector broken` → `cgpro doctor` then file an issue
- `Turn timed out` → bump `--timeout` (max 14400 in daemon mode)
- `[cgpro:web] WARNING ...` → web search couldn't be enabled; surface this so the user knows the answer is from training data only
- `[cgpro:model] ⚠ ...` → model picker silently switched away from Pro; surface the slug returned

## Notes

- `cgpro` keeps a 30-minute shell-session anchor, so consecutive
  `/cgpro:ask` calls thread automatically. Pass `--new-session` for
  a clean slate.
- **Web search is always on.** This is a deliberate policy: freshness
  and citations beat determinism for the use cases this skill serves.
- This skill is GPT-5.5 Pro: it is slow but smart. Use it when
  reasoning quality matters more than speed.

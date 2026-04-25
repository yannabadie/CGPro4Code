---
description: Ask GPT-5.5 Pro a one-shot question (extended thinking + optional web search).
argument-hint: <question>
---

You will use the **cgpro** CLI to forward the user's question to
ChatGPT 5.5 Pro and present the answer in this conversation.

## Steps

1. Run, via the `Bash` tool:

   ```bash
   cgpro ask --json $ARGUMENTS
   ```

   (The `--json` flag gives you a stream of NDJSON events you can
   parse instead of relying on terminal formatting. If you need the
   raw rendered output, drop `--json`.)

2. Parse the NDJSON stream. The terminal `done` event carries
   `finalText` — that is the model's answer. Show it to the user.

3. If the stream ends with an `error` event, relay the message and
   suggest the matching fix:
   - `Not signed in` → `cgpro login` or `cgpro adopt`
   - `Selector broken` → `cgpro doctor` then file an issue
   - `Turn timed out` → retry with `--timeout <bigger>`

## Notes

- `cgpro` keeps a 30-minute shell-session anchor, so consecutive
  `/cgpro:ask` calls thread automatically. Pass `--new-session` for
  a clean slate.
- For live web search, add `--web`. For deterministic answers, add
  `--no-web`.
- This skill is GPT-5.5 Pro: it is slow but smart. Use it when
  reasoning quality matters more than speed.

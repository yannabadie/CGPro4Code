---
description: List the user's saved + remote ChatGPT conversations.
argument-hint: [list|sync|show <name>]
---

Use the **cgpro** CLI to inspect the user's ChatGPT thread inventory.

## Steps

1. If `$ARGUMENTS` is empty or "list":

   ```bash
   cgpro thread list --remote --refresh --json
   ```

   This refreshes the cache from chatgpt.com first, then dumps the
   full list as JSON. Parse, summarize, and show the user.

2. If `$ARGUMENTS` starts with "show ", run `cgpro thread show <name>`
   and show the output.

3. If `$ARGUMENTS` is "sync", run `cgpro thread sync` and report.

The user can resume any conversation with
`cgpro ask --resume <name|uuid> "..."`.

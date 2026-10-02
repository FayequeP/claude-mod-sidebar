# meter-sidebar

**A live stats sidebar for Claude Code:** context use, token counts, prompt-cache
hit rate and expiry, the model's real output speed, and your git state, docked
beside the conversation.

```
Context                        31.4%
███████████▎░░░░░░░░░░░░░░░░░░░░░░░░
Cache
Hit rate                       94.4%
█████████████████████████████████▉░░
Expires in   42:13 / 1h · subscription
Speed
Output                      86 tok/s
```

## Install

```sh
claude plugin marketplace add FayequeP/claude-mod-sidebar
claude plugin install meter-sidebar@claude-mod-sidebar
```

It needs Claude Code 2.1.269+ with function hooks turned on in
`~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

To dock it as a sidebar in the terminal, use the fullscreen renderer
(`/tui fullscreen`). On the classic screen it shows as a compact strip above
the prompt.

## What it shows

| Section | What you get |
|---|---|
| **Context** | How full the context window is, as a bar and `85.4k / 272k` |
| **Tokens** | Input, output, cache read, cache write and the session total |
| **Cache** | Hit rate, and a countdown to when the prompt cache expires |
| **Speed** | Time to first token and output speed in tokens per second |
| **Workspace** | Folder, git branch, clean or changed, lines added and removed |

## Show and hide

- Type `/sidebar`, or press the **Hide sidebar** button at its foot.
- For a keyboard shortcut (terminal), add this to `~/.claude/keybindings.json`
  and press `ctrl+x s`:

  ```json
  { "bindings": [ { "context": "Global", "bindings": { "ctrl+x s": "app:toggleReplTab" } } ] }
  ```

  Plugins can't own a key yet, so the sidebar's toggle button borrows that
  engine action and the chord presses it.

## How the numbers are measured

<details>
<summary><b>Output speed</b></summary>

Output tokens divided by the time from the first streamed piece of the response
to the last one. Text, thinking and tool-call arguments all count. Token counts
come from the API's `usage.output_tokens`; while a response is still
streaming, a live estimate of about 4 characters per token is shown instead.

Responses that arrive in under half a second are skipped, because one network
burst would read as thousands of tokens per second. The previous reading stays
on screen.

</details>

<details>
<summary><b>Cache expiry</b></summary>

The prompt cache lives for a fixed time after each request. Send your next
message before **Expires in** reaches zero and the conversation is read from
cache, which is cheaper and faster. After that, the whole context is written
to cache again.

The sidebar works out the time to live the way Claude Code does for the main
conversation. The first rule that matches wins, and its source is shown after
the time, for example `42:13 / 1h · subscription`:

| Shown as | Rule | Lasts |
|---|---|---|
| `env` | `CLAUDE_CODE_PROMPT_CACHE_TTL` set to `5m` or `1h` | as set |
| `env` | `FORCE_PROMPT_CACHING_5M=1` | 5 min |
| `env` | `ENABLE_PROMPT_CACHING_1H=1` | 1 hour |
| `setting` | `"promptCacheTtl": "5m"` or `"1h"` in settings.json | as set |
| `subscription` | Claude subscription within its usage limits | **1 hour** |
| `over limit` | Subscription with a usage window at 100% | 5 min |
| `API key` | API key, Bedrock, Vertex or Foundry | 5 min |

These defaults come from Claude Code's own description of `promptCacheTtl`
(v2.1.287). A subscription is recognised by Claude Code reporting usage-limit
windows, which happens after the first reply of a session. Subagents and
background helpers use 5 minutes by default on every plan; the countdown
follows the main conversation only.

</details>

## Develop

```sh
git clone https://github.com/FayequeP/claude-mod-sidebar.git
claude --plugin-dir ./claude-mod-sidebar   # load from source for one session
claude plugin validate .
claude plugin test .
```

`.claude/types/` is git-ignored. Regenerate the type declarations inside a
session with `/plugin-types`, then run `tsc -p .`.

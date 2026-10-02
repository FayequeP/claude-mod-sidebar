# claude-mod-tps-meter

A Claude Code mod (function-hooks plugin) that shows the model's actual speed
under the prompt, on every turn (and in the desktop app\x27s prompt-footer mode labels):

```
66.6 TPS · avg 55.2 · ttft 0.8s
```

- **TPS** — output tokens per second, from the API's real `usage.output_tokens`
  over the streaming span (first token → last chunk)
- **avg** — running mean TPS across finished steps, persisted via `$.store`
- **TTFT** — time to first token, request start → first streamed token

While a response streams, a live estimate (~4 chars/token) is shown instead.

## Install

Enable function hooks in `~/.claude/settings.json` (this also loads the hooks
module of every other installed plugin that ships one):

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

Requires Claude Code 2.1.269+ and an interactive terminal.

```sh
claude plugin marketplace add FayequeP/claude-mod-tps-meter
claude plugin install tps-meter@claude-mod-tps-meter
```

or load from source for one session:

```sh
git clone https://github.com/FayequeP/claude-mod-tps-meter.git
claude --plugin-dir ./claude-mod-tps-meter
```

## Develop

```sh
claude plugin validate .
claude plugin test .
```

`.claude/types/` is git-ignored; regenerate the type declarations inside a
session with `/plugin-types`, then `tsc -p .`.

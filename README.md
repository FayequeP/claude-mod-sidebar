# meter-sidebar

A Claude Code mod (function-hooks plugin) that shows the model's actual speed
in a docked **Meter sidebar** beside the transcript, on every turn:

```
CONTEXT          31.4%
█░░░░░░░░░░░░
TOKENS
↑ Input          10
↓ Output         20
CACHE            100.0%
Valid for        5:00
ACTIVITY
First token      800ms
Output speed     66 tok/s
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
claude plugin install meter-sidebar@claude-mod-tps-meter
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

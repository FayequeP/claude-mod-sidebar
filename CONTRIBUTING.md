# Contributing

Thanks for helping improve the sidebar. Bug reports, ideas and pull requests
are all welcome.

## Reporting a bug

Open an issue with:

- what you saw, and what you expected instead
- a screenshot of the sidebar if it is a display problem
- your Claude Code version (`claude --version`), and whether it happened in
  the terminal or the desktop app

## Running it from source

You need Claude Code 2.1.269+ with function hooks turned on in
`~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

Then clone the repo and start a session with your local copy loaded:

```sh
git clone https://github.com/FayequeP/claude-mod-sidebar.git
cd claude-mod-sidebar
claude --plugin-dir .
```

In the terminal, run `/tui fullscreen` so the sidebar docks beside the
conversation. If you also have the published plugin installed, disable it
while you work so you don't get two sidebars:

```sh
claude plugin disable sidebar@claude-mod-sidebar
```

## Where things live

| File | What it does |
|---|---|
| `hooks/register.tsx` | The whole plugin: measuring speed and tokens, the cache countdown, and drawing the sidebar |
| `hooks/tps.test.tsx` | Tests, run with `claude plugin test .` |
| `.claude-plugin/plugin.json` | Plugin name, version and description |
| `.claude-plugin/marketplace.json` | The marketplace listing people install from |
| `docs/` | Images used in the README |

## Before you open a pull request

1. Check the plugin loads and the tests pass:

   ```sh
   claude plugin validate .
   claude plugin test .
   ```

2. If you changed how the sidebar looks, check it in both the terminal and the
   desktop app, and add a screenshot to the pull request.
3. If your change should reach installed copies, bump `version` in **both**
   `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.
   Installed plugins only update when the version changes.
4. If you added logic (a calculation, a branch, a parser), add a small test for
   it in `hooks/tps.test.tsx`.

## Style

- Match the code around your change: its naming, comment density and layout.
- Keep the sidebar calm: one accent color, with green, amber and red only for
  status.
- Keep changes small and focused, one thing per pull request.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).

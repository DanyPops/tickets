# @danypops/pi-tickets

Pi extension exposing the [tickets](https://github.com/DanyPops/tickets) daemon
(GitHub/GitLab/Jira issue tracking) as an LLM-callable tool, plus a `/tickets`
interactive TUI for browsing pooled issues and setting focus.

## Install

```json
{ "packages": ["npm:@danypops/pi-tickets"] }
```

in pi's `settings.json`. Requires `@danypops/tickets` (installed automatically
as a dependency) — the daemon it talks to spawns on first use.

## Tool

`tickets` — one action per CLI command: `list`, `get`, `create`, `update`,
`search`, `children`, `comments`, `comment_add`, `backends`, `ledger_search`,
`ledger_stats`, `focus_set`, `focus_get`, `focus_pause`, `focus_unpause`,
`focus_clear`. OAuth login and daemon lifecycle control are deliberately not
exposed here — run `tickets auth login` / `tickets daemon stop` from a
terminal instead.

## `/tickets` command

Browsable list of every pooled issue across configured backends. `↑↓`
navigate, `enter` sets focus, `o` opens the issue's URL in a browser, `esc`
cancels. A footer status shows the current focus, kept in sync with focus
changes the LLM makes via the tool.

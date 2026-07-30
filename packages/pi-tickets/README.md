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

## Tools

One real Pi tool per operation -- projected from the daemon's own
[Vehicle](https://github.com/DanyPops/vehicle) registry, not a single
action-dispatch mega-tool: `issue_list`, `issue_get`, `issue_create`,
`issue_update`, `issue_search`, `issue_children`, `issue_comments`,
`issue_comment_add`, `backends_list`, `ledger_search`, `ledger_stats`,
`focus_set`, `focus_get`, `focus_pause`, `focus_unpause`, `focus_clear`,
`discover_fields`, `discover_statuses`, `discover_template`. OAuth login and
daemon lifecycle control are deliberately not exposed here — run `tickets
auth login` / `tickets daemon stop` from a terminal instead.

These tools only appear once the tickets daemon has been started at least
once (via the `/tickets` command below, or the CLI) — registering them
never spawns the daemon itself, the same rule this extension already
follows for its footer status. Once started, the daemon keeps running
across Pi sessions, so this is a one-time thing per machine, not a
per-session wait.

## `/tickets` command

Browsable list of every pooled issue across configured backends. `↑↓`
navigate, `enter` sets focus, `o` opens the issue's URL in a browser, `esc`
cancels. A footer status shows the current focus, kept in sync with focus
changes the LLM makes via the tool.

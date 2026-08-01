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

`/tickets` with no arguments opens one persistent panel -- a tab bar of
every configured provider (GitHub, GitLab, Jira), each staying mounted for
the whole session so switching tabs never tears down and reopens a
different screen. Every provider gets an Issues tab; a provider with a real
query language (Jira's JQL today) also gets Saved queries and a Kanban
Board view. `Tab`/`Shift-Tab` or `←`/`→` cycle tabs; a mnemonic letter
jumps directly (shown highlighted in each tab's own label); `s` opens
`/secrets` without leaving the panel; `esc` returns to the first tab from
any other, or closes the panel from the first tab.

Within an issue list: `↑↓` navigate, `enter` sets focus (or clears it on
the synthetic first row when one is already set), `v` opens the full issue
detail view, `o` opens the issue's URL in a browser, `r` reloads from
source. A footer status shows the current focus, kept in sync with focus
changes the LLM makes via the tool.

`/tickets <query>` skips the panel and pushes a single one-shot search view
over every configured backend.

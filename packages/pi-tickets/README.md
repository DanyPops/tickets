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

`backends_list` is a local, credential-safe readiness report: it distinguishes
ready/partial/blocked/unknown read and write configuration, lists only missing setting
names, and reports connectivity as `not_checked`. It never contacts a provider
or returns credential values.

New tool rows persist only the strict, versioned `tickets.tool-details/v1`
presentation DTO. List, detail, mutation, summary, and error views have separate
row/text/serialized-size bounds plus explicit omission metadata; descriptions,
comment bodies, staged payload text, raw saved queries, custom backend fields,
and credential values are excluded. Model content remains an independent bounded
channel. Historical `details.output` rows retain a bounded rendering fallback;
malformed or future presentation versions fall back to model content without
throwing during session replay.

These tools only appear once the tickets daemon has been started at least
once (via the `/tickets` command below, or the CLI) — registering them
never spawns the daemon itself, the same rule this extension already
follows for its footer status. Once started, the daemon keeps running
across Pi sessions, so this is a one-time thing per machine, not a
per-session wait.

### Watching issues and saved queries

`issue_subscribe`/`issue_unsubscribe`/`issue_subscribed` and
`query_subscribe`/`query_unsubscribe`/`query_subscribed` have the daemon keep
an issue or a saved query under background watch — a status change, a new
comment, or an item appearing in (or dropping out of) a saved query's results
is recorded as a `watch_events` entry, the same shape
[pipes](https://github.com/DanyPops/pipes)' own `ci_subscribe` uses for CI
runs. This session polls `watch_events` on its own schedule and surfaces each
new one directly in the conversation — no manual re-checking needed. Like
`ci_subscribe`, this is bounded background polling presented as a change
feed, not a real webhook from GitHub/GitLab/Jira.

## `/tickets` command

`/tickets` with no arguments opens one persistent panel -- a tab bar of
every configured provider (GitHub, GitLab, Jira), each staying mounted for
the whole session so switching tabs never tears down and reopens a
different screen. A plain provider's tab is its Issues list directly; a
provider with a real query language (Jira's JQL today) gets a real
submenu instead -- its own Issues/Saved queries/Board view tabs, nested one
level inside its own provider tab. `Tab`/`Shift-Tab` and `←`/`→` cycle
whichever level's tabs you're currently in (the outer provider bar, or,
once you're inside a provider's own submenu, its own three tabs); a
mnemonic letter jumps directly, scoped like a real menu bar's own
accelerators -- a provider's own letter works from anywhere, a submenu's
own letters only once that submenu is active. `s` opens `/secrets` without
leaving the panel; `esc` ascends one level at a time -- a submenu's own
home, then the outer panel's own home, then closes.

Within an issue list: `↑↓` navigate, `enter` sets focus (or clears it on
the synthetic first row when one is already set), `v` opens the full issue
detail view, `o` opens the issue's URL in a browser, `r` reloads from
source. A footer status shows the current focus, kept in sync with focus
changes the LLM makes via the tool.

`/tickets <query>` skips the panel and pushes a single one-shot search view
over every configured backend.

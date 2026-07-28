# tickets

A unified CLI, daemon, and TypeScript library for issue tracking across
**GitHub**, **GitLab**, and **Jira** — plus a `pi-tickets` extension so a
coding agent can query and mutate issues the same way the CLI does.

## Why a daemon

Every backend adapter pools issues into a local SQLite ledger on its own
schedule, independent of whether anything is currently asking for data —
`tickets ledger search`/`ledger stats` and the ledger ops still answer from
the last successful sync even if a backend is slow, rate-limited, or
temporarily unreachable. The CLI and the pi-tickets extension are both thin,
interchangeable clients of one authenticated RPC daemon; neither talks to
GitHub/GitLab/Jira or opens the SQLite ledger directly. See
[RESEARCH.md](RESEARCH.md) for the sources this was built against.

## Requirements

- **[Bun](https://bun.sh) 1.1+.** The daemon uses `bun:sqlite` and
  `Bun.serve` (via `@danypops/daemon-kit`); the CLI, library, and pi-tickets
  extension are plain TypeScript but currently ship as source, run through
  Bun rather than a compiled Node build.
- `@danypops/daemon-kit` comes from the public npm registry (`^0.2.1`) —
  no local checkout or `file:` path needed, `bun install` fetches it directly.

## Install

```bash
bun install
```

## Run

```bash
# Start the daemon (binds 127.0.0.1 on an ephemeral port; writes a handle +
# auth token under $XDG_RUNTIME_DIR/tickets and $XDG_STATE_HOME/tickets).
bun run daemon

# Or let the CLI manage it — every issue/ledger command below auto-starts the
# daemon on first use if it isn't already running.
bun run src/cli/index.ts daemon status    # never auto-starts; just checks
bun run src/cli/index.ts daemon start
bun run src/cli/index.ts daemon stop      # asks it to shut down gracefully
bun run src/cli/index.ts daemon restart

bun run src/cli/index.ts backends
bun run src/cli/index.ts list -b github --status todo
bun run src/cli/index.ts get jira:PROJ-42
bun run src/cli/index.ts create -b github "Fix the thing" --label bug
bun run src/cli/index.ts comment add jira:PROJ-42 "Looks good, shipping"
bun run src/cli/index.ts ledger search "login bug"
bun run src/cli/index.ts ledger stats

# Track the single ticket you're currently working on, with its full URL —
# survives daemon restarts, resolves the ref via the ledger first (no live
# call if it's already cached) and falls back to the backend otherwise.
bun run src/cli/index.ts focus set jira:PROJ-42
bun run src/cli/index.ts focus get
bun run src/cli/index.ts focus pause "waiting on review"
bun run src/cli/index.ts focus unpause
bun run src/cli/index.ts focus clear
```

### Running the daemon persistently (systemd --user)

`daemon start` spawns the daemon on demand and it lives only as long as
something keeps it alive. For a daemon that survives logout/reboot, install
it as a systemd `--user` service instead (Linux only):

```bash
bun run src/cli/index.ts service install   # writes + enables + (re)starts the unit
bun run src/cli/index.ts service status
bun run src/cli/index.ts service stop
bun run src/cli/index.ts service restart
bun run src/cli/index.ts service path      # where the unit file lives
```

`service install` points `ExecStart` at the exact `bun` binary and package
checkout currently running the CLI, so re-running it after an upgrade (a new
`npm`/`bun` global install, or a fresh checkout) picks up the new path
immediately via `daemon-reload` + `enable` + `restart` — no manual `stop`
needed first.

Once installed as a package, the same commands are available as `tickets`
and `tickets-daemon` (see `bin` in `package.json`).

## Configuration

### Environment variables

```bash
# GitHub (token optional for public-repo reads)
export GITHUB_TOKEN=ghp_xxx
export GITHUB_OWNER=your-org
export GITHUB_REPO=your-repo

# GitLab (token optional for public-project reads)
export GITLAB_TOKEN=glpat-xxx
export GITLAB_PROJECT=namespace/project
export GITLAB_URL=https://gitlab.example.com   # optional, defaults to gitlab.com

# Jira
export JIRA_API_TOKEN=xxx
export JIRA_URL=https://yourcompany.atlassian.net
export JIRA_EMAIL=you@yourcompany.com
export JIRA_PROJECT=PROJ
```

### Config file (multi-instance)

`$XDG_CONFIG_HOME/tickets/config.yaml` (default `~/.config/tickets/config.yaml`):

```yaml
backends:
  github:
    owner: your-org
    repo: your-repo
    token_env: GITHUB_TOKEN

  gitlab:
    project: namespace/project
    token_env: GITLAB_TOKEN

  jira:
    url: https://yourcompany.atlassian.net
    email: you@yourcompany.com
    token_env: JIRA_API_TOKEN
    project: PROJ

  jira-staging:            # multi-instance: same type, different name
    type: jira
    url: https://staging.atlassian.net
    email: you@yourcompany.com
    token_env: JIRA_STAGING_TOKEN
```

## Delegated OAuth login (instead of a static token)

Each backend supports a different real delegated-auth flow — see
[RESEARCH.md](RESEARCH.md) for exactly which, and why Jira's is shaped
differently from GitHub/GitLab's:

```bash
# GitHub / GitLab: device flow — opens a browser, prints a short code.
tickets auth login --backend github --client-id <your-github-oauth-app-client-id>
tickets auth login --backend gitlab --client-id <your-gitlab-application-id>

# Jira: authorization code grant — opens a browser, receives the callback
# on a local loopback server. Atlassian's 3LO apps are confidential clients
# (no PKCE, no device flow), so a client secret is required here.
tickets auth login --backend jira \
  --client-id <your-atlassian-oauth-client-id> \
  --client-secret <your-atlassian-oauth-client-secret>

tickets auth status
tickets auth logout github
```

A stored, still-fresh delegated token always takes precedence over a static
config/env token for that backend. Tokens are written to
`$XDG_STATE_HOME/tickets/oauth/<backend>.json`, mode `0600`, and are never
printed by any command. **Restart the daemon** after logging in so it picks
up the new credential — `buildRepositories()` runs once at daemon startup.

### Optional: credentials via Enigma

If an [Enigma](https://github.com/DanyPops/enigma) vault is running,
tickets checks it first on every request, ahead of a stored delegated token
and any static config/env token — a credential Enigma rotates is picked up
on the very next call, no daemon restart needed. Purely additive: tickets
works identically with no Enigma running at all.

Register tickets as a scoped Enigma client (once), then pass the printed
token to the daemon via `ENIGMA_CLIENT_TOKEN`:

```bash
enigma client add tickets --backends github,gitlab,jira
# -> prints a token once; export it wherever the tickets daemon is started
export ENIGMA_CLIENT_TOKEN=<printed token>
```

Without `ENIGMA_CLIENT_TOKEN`, tickets falls back to Enigma's shared
admin-token file if one exists at `$XDG_STATE_HOME/enigma/token` — fine for
a single-user machine where every local daemon is equally trusted, but a
scoped client token is the least-privilege default.

## The `pi-tickets` extension

Published as `@danypops/pi-tickets`. `../pi-tickets/` (this repo's workspace member) registers a single `tickets` tool for
[pi](https://github.com/badlogic/pi) with one action per CLI command (`list`,
`get`, `create`, `update`, `search`, `children`, `comments`, `comment_add`,
`backends`, `ledger_search`, `ledger_stats`, `focus_set`, `focus_get`,
`focus_pause`, `focus_unpause`, `focus_clear`). It talks to the same daemon
through the same authenticated RPC client the CLI uses — never a direct
backend call or a direct SQLite open. OAuth login and daemon lifecycle
control are deliberately **not** exposed here (neither as a tool action nor
as the `/tickets` command below): approving OAuth access requires a human in
a browser, and stopping a shared daemon is an operational decision, not
something an LLM tool call or a casual keypress should trigger. Use
`tickets auth login`/`tickets daemon stop` from a terminal for those.

It also registers a `/tickets [query]` interactive TUI command (for the
human, not the LLM): a browsable list of every issue the daemon's ledger has
pooled across every configured backend in one flat list (no backend picker
needed). `↑↓` navigate, `enter` sets focus on the highlighted issue, `o`
opens its real web URL in a browser without closing the dialog, and `esc`
cancels. When a focus is already set, a "Clear current focus" row appears
first. A persistent footer status (`🎯 backend:key`, or `⏸` when paused)
shows the current focus at all times, refreshed on session start and after
every `tickets` tool call — so a focus the LLM sets via `focus_set` mid-
conversation shows up in the footer too, and vice versa.

To use it, add it to pi's `settings.json`:

```json
{ "packages": ["npm:@danypops/pi-tickets"] }
```

Or, for local development against this monorepo, point at the workspace
member directory instead: `{ "packages": ["/path/to/tickets/packages/pi-tickets"] }`.

## Development

```bash
bun install                # from the repo root -- links both workspace members
bun run typecheck          # both packages
bun test                   # both packages
```

Tests never hit real GitHub/GitLab/Jira/Atlassian: adapters take an
injectable `fetchImpl`, and the daemon tests (`test/daemon/`) run the real
`@danypops/daemon-kit` `startDaemon()`/SQLite/HTTP stack against a scratch
XDG root with a fake `IssueRepository`.

## Architecture

```
Driver (inbound)              Application              Driven (outbound)
┌───────────────┐        ┌─────────────────┐        ┌──────────────────┐
│ CLI (commander)│──RPC──▶│                 │        │ GitHub adapter   │
│ pi-tickets     │──RPC──▶│  tickets-daemon │───────▶│ GitLab adapter   │
│  (Pi tool)     │        │  (TicketService │───────▶│ Jira adapter     │
└───────────────┘        │   + Ledger      │───────▶│ SQLite (Ledger)  │
                          │   + Poller)     │        └──────────────────┘
                          └─────────────────┘
                          built on @danypops/daemon-kit
                          (paths, storage, http, logging, daemon, rpc-client)
```

Hexagonal architecture: `src/domain` has zero I/O, `src/ports` defines the
outbound contract, `src/adapters` implement it per backend, `src/application`
orchestrates by parsing `backend:key` refs and routing to the named
repository, and `src/daemon` is the only place that owns the SQLite ledger,
wraps it in a Bearer-authenticated HTTP RPC surface, and runs the pooling
poller as a `daemon-kit` maintenance task.

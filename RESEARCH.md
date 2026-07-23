# Research notes

This file records the primary sources each adapter and auth flow was built
against, so the design decisions here are traceable instead of guessed.

## Issue-tracking REST APIs

- **GitHub REST API v3 — Issues**: https://docs.github.com/en/rest/issues/issues
  Confirmed live. `githubIssue` field shapes (`number`, `state`, `labels`,
  `pull_request` sentinel for filtering PRs out of the issues endpoint) and
  auth (`Authorization: token <PAT>`, optional for public-repo reads) match
  this doc.
- **GitLab REST API v4 — Issues**: https://docs.gitlab.com/api/issues/
  Confirmed live. Endpoint shapes (`/api/v4/projects/:id/issues`, `iid` vs
  `id`, `state`/`state_event`) and auth (`PRIVATE-TOKEN` header for personal
  access tokens) match this doc.
- **Jira Cloud/Server REST API v2**: https://developer.atlassian.com/cloud/jira/platform/rest/v2/
  `/rest/api/2/issue/{key}`, `/rest/api/2/search` (JQL), and the
  transition-based status model (`/rest/api/2/issue/{key}/transitions`) match
  this doc. Jira does not support a direct "set status" field PUT — status is
  workflow-owned, hence `JiraRepository.transitionTo`.

The three adapters were also cross-checked against a real, working Go
implementation of the same three backends (a separate project, not shipped
here) before being ported to TypeScript, which is why request/response
shapes are exact rather than approximate.

## Delegated OAuth (vs. static personal access tokens)

Static PATs are simple but are exactly the kind of long-lived, broad-scope,
easily-copy-pasted secret that delegated auth exists to avoid. Each backend's
*actual* supported delegated flow was checked directly against its own docs
before implementing anything — the three backends turned out to support three
different flows, not one:

- **GitHub — OAuth 2.0 Device Authorization Grant (RFC 8628)**:
  https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
  `POST https://github.com/login/device/code` → user opens
  `verification_uri`, enters `user_code` → daemon polls
  `POST https://github.com/login/oauth/access_token` with
  `grant_type=urn:ietf:params:oauth:grant-type:device_code`. No client secret,
  no redirect URI, no local callback server — ideal for a headless daemon.
  Requires the device flow to be enabled on a registered GitHub OAuth App;
  the client ID is public.

- **GitLab — OAuth 2.0 Device Authorization Grant**:
  https://docs.gitlab.com/api/oauth2/ ("Device Authorization Grant", GA in
  GitLab 17.9, also available on GitLab.com). Same RFC 8628 shape as GitHub,
  different paths: `POST {url}/oauth/authorize_device`,
  `POST {url}/oauth/token`. Requires a "non-confidential" GitLab OAuth
  application (no client secret for this flow either).

- **Jira/Atlassian — OAuth 2.0 (3LO), Authorization Code grant, no PKCE**:
  https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
  Atlassian's 3LO apps are confidential clients: the docs page has zero
  mentions of PKCE, `code_challenge`, or a device flow — confirmed absent,
  not assumed. Token exchange requires `client_id` **and** `client_secret`.
  This is also the only one of the three that needs a local redirect: we bind
  an ephemeral loopback HTTP server (`src/auth/jira-oauth.ts`,
  `startCallbackServer`), send the user to
  `https://auth.atlassian.com/authorize`, and receive the code on
  `http://127.0.0.1:{port}/callback`.

  A second, easy-to-miss detail from the same doc: an OAuth 2.0 (3LO) access
  token is **not** used against the tenant's own `*.atlassian.net` domain the
  way a Basic-auth API token is. You first call
  `GET https://api.atlassian.com/oauth/token/accessible-resources` with the
  access token to discover the site's `cloudId`, then all further API calls
  go through `https://api.atlassian.com/ex/jira/{cloudId}/...` with
  `Authorization: Bearer <token>`. `JiraRepository` models this as a second,
  separate constructor mode (`JiraOAuthOptions`) alongside the original
  Basic-auth mode (`JiraBasicAuthOptions`) — same port, two adapters-within-
  the-adapter, picked by `config.ts`'s auth precedence.

  Refresh tokens require `offline_access` in the requested scope and use the
  standard `grant_type=refresh_token` shape (`refreshJiraToken`).

### What isn't implemented (honest scope boundary)

- GitHub/GitLab OAuth token refresh: not implemented. GitHub's classic OAuth
  App device-flow tokens are effectively non-expiring in practice; GitLab's
  do expire (`expires_in` in the response) and *do* support the standard
  `grant_type=refresh_token` shape, but a refresh path for it hasn't been
  wired up yet — re-running `tickets auth login --backend gitlab` is the
  current workaround. Jira's refresh function (`refreshJiraToken`) exists and
  is tested, but nothing calls it automatically yet; `config.ts` only checks
  freshness and falls back to a static token when a stored OAuth token has
  expired.
- Multiple Atlassian sites per token: `loginWithJiraAuthorizationCode` picks
  the first accessible site unless a `chooseSite` callback is given. Fine for
  the common single-site case; a config option to pick by hostname would be
  the natural follow-up.

## Architecture inspiration

The domain/ports/adapters/application-service split (and the CLI/MCP-style
single-tool "one entry point per capability" shape the pi-tickets extension
follows) is adapted from a separate, existing Go project that implements the
same idea (issue tracking across Linear/GitHub/GitLab/Jira with a hexagonal
architecture) — ported here in scope to GitHub/GitLab/Jira and to
TypeScript/Bun, not a line-for-line translation.

The daemon itself (XDG paths, auth-token bootstrap, SQLite pragmas/migration
runner, structured logging, Bearer-token HTTP RPC, process lifecycle) is
built on `@danypops/daemon-kit`, a separate local package shared across
several sibling daemons. See that package's own README for the substrate's
design rationale; this project only documents how it's *used* here.

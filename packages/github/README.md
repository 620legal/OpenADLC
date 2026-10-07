# @fleetadlc/github

Everything that holds or uses a GitHub credential: connecting a bot's own
account with the OAuth device flow, keeping what that yields, turning it into
short-lived tokens, and the REST calls made with them. Each bot acts as its own
account, so a call is made as one bot (`GitHubClient`), or — for what no bot may
do, such as inviting the crew, setting rulesets, merging at the merge line or
rewriting the App's webhook — as the GitHub App itself, with its JWT or an
installation token (`src/app-auth.ts` lists what runs as the app).
OpenADLC never holds a personal access token. It is a library with no process and
no port; `src/index.ts` is built to `dist/index.js`. The bridge, hostd, the CLI,
the dispatcher's program, `@fleetadlc/backup` and the integration suites import it.

## Rules it carries

- **One token broker per install.** GitHub rotates a refresh token every time it
  is used, so two components refreshing the same one can lock the account out
  until a person repeats the device flow. `TokenBroker` runs in the bridge
  (`apps/bridge/src/actors.ts`); hostd and the CLI ask the bridge's
  `/internal/tokens/:bot` instead of building one. Two exceptions, neither
  beside a running bridge's refresh: `fleetadlc github` builds one only when
  nothing answers on the bridge's port, under the same advisory lock
  (`github-refresh:<sign-in>`), and `fleetadlc restore` refreshes each GitHub
  sign-in once to take it over (`@fleetadlc/backup`, `src/signins.ts`).
- **Secrets live in the secret store**, never in the database, a log or a
  comment. `getSecretStore()` is a `FileSecretStore` under `$FLEETADLC_HOME/secrets`
  (`~/.fleetadlc/secrets`, one `0600` file per ref), or Google Secret Manager
  (`src/gcp-secrets.ts`, through the metadata server's service account) when
  `FLEETADLC_SECRET_STORE=gcp`, as the cloud module sets. `setSecretStore()` puts another
  store behind the same interface; the tests use it for an in-memory one.
  The install's own credentials are here too: the App's private key
  (`appPrivateKeyRef()`), its client secret (`appClientSecretRef()`) and the
  webhook secret (`webhookSecretRef()`).
- **The install secret** (`internalSecretRef()`, made by `ensureInternalSecret()`)
  is what OpenADLC's own components present to each other. A task's session holds
  only `taskTokenFor(taskId, installSecret)`, an HMAC of its own id under that secret, sent as
  `x-fleetadlc-task-token`: good for that task and nothing else.
- **The console secret** (`consoleSecretRef()`, `console-api-secret`, made by
  `ensureConsoleSecret()`) is what the console's server and the CLI present to
  the bridge's `/v1` on a local install, as `x-fleetadlc-console-secret`, and
  what the console's sign-in links are signed with. It is its own secret
  because the install secret also opens `/internal/dispatch/lease`. A backup
  leaves it out; the restored install makes its own.
- **The alerts secret** (`alertsSecretRef()`, `alerts-secret`, made by
  `ensureAlertsSecret()`) is what an outside monitoring system presents to the
  bridge's `/internal/alerts`, as `x-fleetadlc-alerts-secret`. It opens that
  route and no other, so a monitor never holds the install secret, which mints
  every bot's token.
- **A delivery is trusted by its signature**, computed over the body's bytes
  (`verifyWebhookSignature`). The function verifies against whatever secret it
  is given, the empty string included, so a caller refuses first when none is
  configured, as the bridge's webhook route does.

## Source map

- `src/device-auth.ts` — requesting a device code, polling for the user token, refreshing it.
- `src/token-broker.ts` — short-lived tokens from a stored refresh token; what a task's token must still have left.
- `src/secrets.ts` — the secret store, every ref's name, `fleetHome()`, the install secret and task tokens.
- `src/gcp-secrets.ts` — the secret store on Google Secret Manager, for a cloud install.
- `src/client.ts` — `GitHubClient`: issues, labels, comments, reviews, statuses and pull requests, as one account.
- `src/app-auth.ts` — the App's JWT, and installation tokens for the repositories it is installed on.
- `src/app-hook.ts` — reading and writing the App's own webhook URL and secret, and its recent deliveries.
- `src/invitations.ts` — inviting a bot to a repository, and accepting that invitation as the bot.
- `src/rules.ts` — the rulesets, environments and CODEOWNERS a managed repository should have: checked, then applied.
- `src/templates.ts` — the files a managed repository needs, each written where it is absent; an earlier OpenADLC CI workflow and an `@owner` placeholder are brought up to date.
- `src/repo-config.ts` — reading the files that steer the crew (AGENTS.md, CODEOWNERS, the CI workflow) and the logins they name.
- `src/reviewers.ts` — whether a login can be asked for a review, and the cache of those answers.
- `src/signing.ts` — a bot's SSH commit-signing key, made and read with `ssh-keygen`.
- `src/webhook.ts` — the HMAC check.

## Testing

```bash
pnpm --filter @fleetadlc/github test                                        # every src/*.test.ts
pnpm --filter @fleetadlc/github exec vitest run src/token-broker.test.ts    # one file
pnpm --filter @fleetadlc/github build                                       # tsc; consumers import dist/
```

- **No network, no real store.** Tests stub `fetch` (`vi.stubGlobal`, or the
  client's `fetchImpl`) and use an in-memory store or a temporary directory.
  `src/public-key.test.ts` runs `ssh-keygen`; `src/templates.test.ts` reads
  `crew/templates/repo/` at the repository's root.
- **Consumers read `dist/`, and vitest does not type-check.** Build after a change
  and after the last edit, before the bridge's or hostd's tests see it.
- **Scripts reach real credentials.** Anything that calls `getSecretStore()` with
  no `FLEETADLC_HOME` reads and writes the installed OpenADLC's secrets, and a
  `TokenBroker` built outside the bridge rotates its bots' refresh tokens. Point
  `FLEETADLC_HOME` at a scratch install: [docs/development.md](../../docs/development.md).
  `FLEETADLC_HOME` does not isolate the Secret Manager store, so a script run on
  a cloud host must leave `FLEETADLC_SECRET_STORE` unset.

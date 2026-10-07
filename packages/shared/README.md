# @fleetadlc/shared

The vocabulary the rest of OpenADLC agrees on: the shapes of the rows and messages
that pass between processes, the strings more than one component has to spell
the same way, and the pure rules more than one of them applies. It has no
process and no state, and does no I/O beyond reading a YAML file and `fetchJson`.
It depends on nothing in the workspace — `yaml` and `zod` only — so every
TypeScript package can import it: the bridge, hostd, the dispatcher, the CLI,
`@fleetadlc/db`, `@fleetadlc/github`, `@fleetadlc/engines`, `@fleetadlc/backup` and the
integration suites. The console does not; it keeps copies of the few lists it
shows, and its tests hold them to these.

## Source map

- `src/index.ts` — the barrel, built to `dist/index.js`, which is what `@fleetadlc/shared` resolves to.
- `src/types.ts` — roles, engines, task kinds and states, stage modes, and the row shapes (`Bot`, `Repo`, `Task`, `Gate`…).
- `src/config.ts` — the zod schemas for `config/bots.yaml`, `repos.yaml`, `costs.yaml` and `review.yaml`, and `loadYamlFile`.
- `src/env.ts` — `envOr`, `envInt`, `envBool`, and `DEFAULT_PORTS`: console 47300, bridge 47311, hostd 47312, Postgres 47432.
- `src/stages.ts` — the `adlc:*` stage labels and column titles, `stageFromLabels`, and which moves count as forward.
- `src/markers.ts` — the HTML-comment marker a structured GitHub comment carries; how a gate is rendered and its answer read.
- `src/readiness.ts`, `src/dependencies.ts` — whether an issue says enough to be leased; what it waits on (`### Dependencies`).
- `src/checks.ts` — `REQUIRED_CHECK`, `REVIEW_GATE_CHECK`, and the scope and author rules CI and the review gate enforce.
- `src/human-review.ts` — the `## Human review` section of a repository's `AGENTS.md`, which the bridge reads from the base branch.
- `src/access.ts` — `actsFor`: OpenADLC acts only for an owner, member or collaborator of the repository, or one of its crew.
- `src/seats.ts` — seats and names: a bot is its account's login once connected, its seat before; `resolveBotRef`, `automationBotOf`.
- `src/onboarding.ts` — the walkthrough's steps and words, the App settings and permissions it needs, and `MANUAL_STEPS`.
- `src/app-manifest.ts` — the GitHub App manifest the console creates the App from.
- `src/health.ts`, `src/engine-updates.ts` — the shapes the health checks and the weekly engine update report in.
- `src/http.ts` — `fetchJson` and `HttpError`.
- `src/repo-colors.ts` — the six repository colours, in the order they are handed out.

## Changing it

A constant here is usually matched somewhere else by its spelling, and a test
says where:

| What | Held to it by |
|---|---|
| `REQUIRED_CHECK` | `src/checks.test.ts`, which reads `.github/workflows/ci.yml` for the aggregate job's name |
| stage titles, stage modes, role words, repository colours | the console's `stages.test.ts`, `bot-label.test.ts` and `repo-colors.test.ts`, which read `src/` here |
| `MANUAL_STEPS` | `apps/bridge/src/health/registry.test.ts`: every manual step needs a registered health check (AGENTS.md, "Steps a person has to do") |
| the issue form's `###` headings | `tests/repo-templates.test.ts`, which renders `crew/templates/repo`'s forms and runs `readiness.ts`, `checks.ts` and `dependencies.ts` over them |

## Testing

```bash
pnpm --filter @fleetadlc/shared test                                   # every src/*.test.ts
pnpm --filter @fleetadlc/shared exec vitest run src/markers.test.ts    # one file
pnpm --filter @fleetadlc/shared build                                  # tsc; every consumer imports dist/
```

- **Every consumer reads `dist/`.** A change here reaches the bridge, hostd and
  the rest only after `pnpm --filter @fleetadlc/shared build` (or `pnpm build`); their
  tests run against the last build.
- **vitest does not type-check.** A type changed here can break a consumer that
  vitest still runs happily; `pnpm build` compiles every package and is what
  CI checks, so run it after the last edit.
- **Nothing to start.** The tests need no service, no database and no network.

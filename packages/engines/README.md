# @fleetadlc/engines

The adapters that let a skill run a model without knowing which one. Every
engine implements one interface (`src/types.ts`): `available()`, and `run()`,
which streams `EngineEvent`s — text, a tool call, a file change, a question the
engine will not decide alone, usage, done, an error. Claude and Codex are their
CLIs, run headless as child processes in the task's worktree; so is Grok, and
a host or bot image without the `grok` command cannot run it. `MockEngine`
is the scripted engine the integration suites and the skill dry runs use; it is
never what `none` gets outside a scripted run. Beside the adapters sit the model decisions more than one component makes:
resolving an alias such as `newest:opus` against what an account can call,
listing a provider's models to prove a key, whether a bot's engine and model
credential are ready to run a task, and what a model costs.

It is a library, with no process and no port; `src/index.ts` is built to
`dist/index.js`. hostd is its main user: the skill runner is the only thing that
invokes an engine (`apps/hostd/src/skill-runner.ts`), and hostd resolves models
and answers `/engines` with it. The bridge checks a model assignment and
verifies a model account with it; `@fleetadlc/backup` proves a key before restoring
it. The console must not import it — the barrel pulls the CLIs into a client
bundle — so `apps/console/src/lib/model-onboarding.ts` keeps its own copy of the
families.

## Source map

- `src/index.ts` — the barrel, and `createEngine(name)`: skills ask for an adapter by name and never run a CLI themselves.
- `src/types.ts` — `Engine`, `EngineRunInput`, `EngineEvent`, `ToolsPolicy`.
- `src/claude.ts` — `claude -p --output-format stream-json`, the task's tool policy as Claude Code permission rules, `--setting-sources user --strict-mcp-config` so the worktree's own `.claude/` settings, hooks, `.mcp.json` and `CLAUDE.md` do not load, and `--add-dir` for the folder the work's attachments are in.
- `src/codex.ts` — `codex exec --json`, reading both event shapes Codex has written; the work's images as one `--image=` token on the first turn.
- `src/grok.ts` — the `grok` CLI with a closed list of what it may run; it reads the work's attachments from the list in its context.
- `src/mock.ts` — `MockEngine`: scripted lines, file touches, one question or one plan change, fixed usage.
- `src/stream-json.ts`, `src/process-engine.ts` — the stream Claude Code and Grok share, each message's usage counted once; spawning a CLI.
- `src/model-choice.ts` — aliases and `resolveModel`, `checkModelAssignment`, and `ledgerModel`: the ledger gets a concrete id, never the alias.
- `src/provider-models.ts`, `src/model-catalog.ts` — what a key or a subscription token can call, cached for a few minutes.
- `src/readiness.ts` — whether each bot's engine and model credential are ready to run a task, saying how sure that answer is.
- `src/pricing.ts` — default prices per million tokens, which the install's `config/models.yaml`, where it has one, overrides (copy `config/models.example.yaml`; git ignores the copy). hostd and the bridge read and check that file from `FLEETADLC_CONFIG_ROOT` at start (`readModelPrices`); a session takes the prices only from `FLEETADLC_MODEL_PRICES`, which hostd hands it (`loadModelPrices`), and never reads a file from its working directory, the managed repository's checkout.
- `src/tools.ts` — a skill's `tools.yaml` (`crew/skills/<name>/tools.yaml`): the shell allow-list, the write scope, and `FLEETADLC_TOOLS_POLICY`, the git and GitHub rules that OpenADLC's own `git` and `gh` (`apps/hostd/bin/`) apply on every engine.

## Testing

```bash
pnpm --filter @fleetadlc/engines test                                      # every src/*.test.ts
pnpm --filter @fleetadlc/engines exec vitest run src/model-choice.test.ts  # one file
pnpm --filter @fleetadlc/engines build                                     # tsc; hostd and the bridge import dist/
```

- **No engine is needed.** `src/engines.test.ts` writes small fake `claude`,
  `codex` and `grok` executables into a temporary directory, hands their paths
  to the adapters and records what each was asked; nothing calls a provider. It
  also reads `config/bots.yaml` at the repository's root.
- **Consumers read `dist/`, and vitest does not type-check.** Build after a
  change here, and after the last edit, before hostd's tests or a restarted
  hostd see it.
- **`none` does no work.** A `MockEngine` makes its output up, so only a
  scripted run (`FLEETADLC_SCRIPTED_ENGINES=1`) gets one. Otherwise
  `createEngine('none')` refuses, and hostd refuses a task on a seat whose
  engine is `none` before it asks whether the engine is available
  (`apps/hostd/src/engine-choice.ts`), rather than letting it fabricate.

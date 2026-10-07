# @fleetadlc/backup

Backing an install up and putting it back. Nothing else can reconstruct an
install's durable credentials — the App's private key is shown once by GitHub,
the signing keys were made here, and the webhook secret, the settings and which
account each bot is live only in this install — so this package decides what an
archive holds, seals it, and decides and carries out a restore: onto a clean
install, or into one that is already set up, with an undo. It decides for all
three places a person can do it — `fleetadlc backup` and `fleetadlc restore`
(`apps/cli/src/commands/backup.ts`), the console's Settings → Backup card and the
walkthrough's first step (`apps/bridge/src/backup.ts`, `restore-into.ts`) — so
the three cannot drift. hostd uses it too, to read and write a subscription's
sign-in folder. It is a library with no process and no port; `src/index.ts` is
built to `dist/index.js`.

## How a restore goes

1. **Every sign-in is judged first** (`src/signins.ts`): the same as here, works
   (proved without side effects), blocked (expired, refused, or spent by this
   install since the backup), or check-by-use — a GitHub refresh token or a
   subscription's sign-in folder, which rotate when used. A bot's own engine key
   (`engine-key-<bot>`) is judged too, against its engine's provider. A blocked
   one is never written.
2. **A plan**, names only (`src/plan.ts`), is shown before anything is written.
   The walkthrough's restore is refused anywhere but a clean install
   (`src/clean.ts`).
3. **One transaction** writes the rows and then the secrets (`src/apply.ts`); if
   a secret cannot be written, the rows roll back and the secrets go back as
   they were.
4. **Rotating sign-ins are taken over** only once the provider accepts them, and
   every bot that now holds one takes its account's handle (`src/restore.ts`).

## Seats that share a GitHub account

Several seats may sign in as one GitHub account (`github_identities`,
migration 0014). The account holds one sign-in, filed under its name
(`github-refresh-<secret_ns>`), which is often no seat's name at all. So an
archive (format version 3) carries each account once — its login, its GitHub
user id, the name its sign-in is filed under, and the seats on it — and the
sign-in once, under that name; each seat keeps its own record and its own
signing key. A restore puts the seats back on one account, files the sign-in
where the bridge's `signInOf` looks for it, and judges and takes it over as one
sign-in: a refresh token rotates on every use, so refreshing it once per seat
would leave all but one of them signed out. Seats on a shared account keep
their seats' names; a seat on an account of its own takes the handle, as
before.

An archive from before version 3 has no accounts in it: each bot with a login
was an account of its own, its sign-in filed under the bot's name, and that is
how it is read (`archivedIdentities` in `src/plan.ts`).

The key the crew's posts are signed with (`attribution-key`) travels with the
install, like the App's key, so posts signed before a move still check after
it. A restore merges it rather than writing over it: the archive's key signs
from then on, and one this install had already made is kept among the retired
keys that still check.

Restoring into an install that is set up compares the two item by item first
(`src/compare.ts`) and never deletes anything; `src/undo.ts` can put back what it
touched for a day. That includes the crew's signing key — this install's own
signs again, and the archive's is kept among the retired keys, so posts signed
in between still check — and each seat's color and avatar.

The spending caps come with the install. Onto a clean install the archive's
list becomes the table. Into an install that is set up they are one item on
the comparison, unticked when they differ; taken, each cap the archive names
is set over this install's of the same name, any cap only this install has is
kept, the writes take the lock saving from Settings takes and leave a
`spending.limit_changed` audit row each, and caps that would put a
repository's above the global one are refused. `fleetadlc restore` lists the
caps it would set before it asks, and merges them the same way into an
install in use.

A repository is matched by its full name. OpenADLC names each repository by
its name alone, so an archived repository whose name another repository here
has — `other/widgets` beside `acme/widgets`, or a removed one that still holds
the name — cannot be taken: the comparison says why, and a restore that is
handed it anyway (`fleetadlc restore` included) stops with an error before it
writes over the other's row.

## Source map

- `src/selection.ts` — what a person chose: the install, repositories, the crew or some seats, model accounts, history, and sign-ins.
- `src/contents.ts` — an install snapshot into an archive's contents (`buildBackup`), and what kind of secret each ref is.
- `src/archive.ts` — the `.fleetbak` format: a cleartext manifest over an AES-256-GCM body keyed with scrypt, or the plain form.
- `src/live.ts` — the install as Postgres and the secret store hold it, read for a backup and written by a restore.
- `src/signins.ts`, `src/restore.ts` — the verdicts and the take-over; a restore start to finish.
- `src/plan.ts`, `src/apply.ts`, `src/clean.ts` — deciding, carrying out, and whether the target is clean.
- `src/compare.ts`, `src/undo.ts`, `src/undo-store.ts` — restoring into an install in use, and its undo, kept under `$FLEETADLC_HOME/restore-undo`.
- `src/summary.ts` — what an archive holds and what a restore would do, by name, never by value.
- `src/login-files.ts` — a subscription's sign-in folder as files: the sign-in (`sign-in/auth.json`) and the sealed files, nothing else.
- `src/test-fixtures.ts` — invented installs for the tests, whose values no name contains.

## Testing

```bash
pnpm --filter @fleetadlc/backup test                                    # every src/*.test.ts
pnpm --filter @fleetadlc/backup exec vitest run src/restore.test.ts     # one file
pnpm --filter @fleetadlc/backup build                                   # tsc; the CLI, bridge and hostd import dist/
```

- **Decisions are pure.** The tests run them against `memoryInstall()` and the
  fakes in `src/test-fixtures.ts`, and write archives, sign-in folders and undo
  files only into temporary directories. No database, no network.
- **A leak is a failure.** The fixtures' values are chosen so a test can search
  anything printed, audited or planned for them; keep new fixtures that way.
- **Consumers read `dist/`, and vitest does not type-check.** Build after a
  change, and after the last edit, before the CLI's or the bridge's tests see it.
- **`live.ts` is the real install.** Its reads and writes use `@fleetadlc/db` and
  `getSecretStore()`, whose defaults are the installed OpenADLC's database and
  `~/.fleetadlc`: [docs/development.md](../../docs/development.md).

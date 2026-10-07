# @fleetadlc/console

The console is OpenADLC's web interface: the board, each bot's thread with its
questions, "Needs you", the crew, costs, settings, the setup walkthrough at
`/onboarding`, and the Computer and Terminal tabs where a person watches a bot
or takes its keyboard. It is a Next.js 15 app (App Router, React 19, Tailwind 4)
with no database and no `@fleetadlc/*` dependency: every read and every write goes
to the bridge, from the console's own server. The one connection the browser
makes anywhere else is the terminal socket, which goes straight to hostd.

## Running

- **Entry point.** `src/app/`: pages, route handlers and server actions.
  `fleetadlc up` starts the console last, under the keeper
  (`apps/cli/src/keep-running.ts`), as `pnpm start` in `apps/console`: `next
  start` over the `.next/` that `pnpm build` produced, with
  `FLEETADLC_CONSOLE_SECRET` in its environment and nobody else's. It is up when
  `/signin` answers. Log: `~/.fleetadlc/run/console.log`.
- **Port.** 47300 on 127.0.0.1: `FLEETADLC_CONSOLE_PORT` and
  `FLEETADLC_CONSOLE_HOST` (default `127.0.0.1`) in the `start` and `dev`
  scripts. `fleetadlc up` sets the port from `ports.console`; set
  `FLEETADLC_CONSOLE_HOST=0.0.0.0` to open the console from another machine.
- **The bridge's address is read at start.** Only server code calls the bridge,
  at `FLEETADLC_BRIDGE_URL` (default `http://127.0.0.1:47311`), which `fleetadlc up` sets;
  `next.config.ts` keeps it out of `env` so a build does not fix it
  (`src/lib/next-config.test.ts`). The terminal's address,
  `NEXT_PUBLIC_FLEETADLC_TERMINAL_URL`, is read at start too, by the server action
  that mints a terminal token, which hands it to the browser
  (`src/lib/terminal-url.ts`); without it the terminal connects to port 47312 on
  the page's host.

## How it reaches the bridge

- **Server components** read through `src/lib/api.ts` (`api.board()`, `api.crew()`…).
- **Server actions** in `src/app/actions.ts` write: answer a gate, move a card,
  file a request, retry a task, kill a session, restart a bot, change a repository.
- **Route handlers** under `src/app/api/**/route.ts` are thin proxies for what the
  browser fetches itself — onboarding, model accounts, backup and restore, the
  webhook — and `api/thread/[bot]/stream` and `api/item/[subject]/stream` pass
  a thread's and a work item's event stream through.

On a local install the console has a sign-in of its own (`src/lib/sign-in.ts`).
`fleetadlc up` prints a link, `/signin?token=…`, and `fleetadlc console-link`
prints a fresh one; `src/app/signin/route.ts` turns a valid token into a
`fleetadlc_session` cookie and sends the browser to the board. Both are HMACs
under the console secret, checked with Web Crypto, so nothing is stored.
`src/middleware.ts` answers every other path with 401 until the browser has
that cookie, and with 503 when the console was started without
`FLEETADLC_CONSOLE_SECRET`. Behind IAP (`FLEETADLC_IDENTITY_MODE_EXPECTED=iap`)
IAP signs people in and none of this applies.

`src/lib/identity.ts` puts `x-fleetadlc-console-secret` on every call to the
bridge, and an `x-fleetadlc-identity`: `FLEETADLC_IDENTITY`, else `console`.
Behind IAP it forwards IAP's headers too, and names the IAP email; without IAP
in front those headers are whatever the browser sent, so it never forwards
them. The bridge decides what that identity may do. `src/middleware.ts` also
refuses a state-changing `/api/*` request from a page on another origin,
because Next checks the origin of a server action and not of a route handler.
See [docs/security.md](../../docs/security.md).

## Source map

- `src/app/page.tsx` — the board; sends an install to `/onboarding` until the walkthrough is complete (`?board=1` skips that).
- `src/app/onboarding/page.tsx`, `src/components/onboarding-view.tsx` — the walkthrough, step by step.
- `src/app/crew/page.tsx`, `src/app/costs/page.tsx`, `src/app/settings/page.tsx` — the other pages.
- `src/app/actions.ts`, `src/app/api/` — the writes, and the proxies above.
- `src/lib/api.ts`, `src/lib/identity.ts` — `BRIDGE_URL`, the response types, and who the caller is.
- `src/lib/sign-in.ts`, `src/app/signin/route.ts` — the sign-in link and the session cookie.
- `src/components/board-view.tsx`, `src/lib/card-status.ts` — the columns, and the line each card says about itself.
- `src/app/items/[subject]/page.tsx`, `src/components/item-view.tsx`, `src/lib/item.ts` — a work item (a request, its issue and its pull request) as one conversation: every entry headed by the role and seat that said it, a tab per role, a Computer and a Terminal tab per running task, and a box that answers the question picked by its id. A board card opens it as a sheet (`/?item=<subject>`, with `&role=` for a role's tab); the page is the same view.
- `src/components/attachment-drop.tsx`, `src/lib/attachments.ts`, `src/app/api/attachments/` — files given with a request or a message: dropped, pasted or picked, each uploaded at once with its progress through a route handler (a server action stops at one megabyte), refused naming the file, and served back through the console for a preview.
- `src/components/design-memory.tsx` — Settings → Repositories → Design memory: what the design stage is told a repository has decided, reworded, accepted, retired or marked superseded by an admin; the item view shows what its design proposed.
- `src/components/thread-panel.tsx` — a bot's own conversation and its questions, its subjects grouped by work item (a thread about no subject under "Not about any item"), each group linking to its item; its Computer and Terminal tabs.
- `src/components/task-computer.tsx` — the Computer (pane, worktree, sessions) and Terminal tabs, shared by a bot's panel and a work item's tasks; an item's tab opens on the task's own session.
- `src/components/terminal.tsx` — xterm on the hostd socket, the attach token as its subprotocol.
- `src/components/needs-you.tsx`, `src/components/app-header.tsx` — what waits on a person, a work card opening its item on the tab of the role that asked (a check on the install still opens the bot's panel); the header on every page.
- `src/components/crew-view.tsx`, `src/lib/crew.ts` — the crew in sections by role, in pipeline order, each seat saying whom it shares its GitHub account with, its current task opening that task's item.
- `src/lib/model-onboarding.ts` — what the two model steps decide, apart from their widgets.
- `src/lib/stages.ts`, `src/lib/repo-colors.ts`, `src/lib/bot-label.ts` — how a stage, a repository and a bot are shown, each in one place.
- `src/app/globals.css` — the colour tokens for both themes; `src/lib/contrast.test.ts` measures them.

## Testing

```bash
pnpm --filter @fleetadlc/console test                                             # vitest over src/**/*.test.ts(x)
pnpm --filter @fleetadlc/console exec vitest run src/components/board-view.test.tsx   # one file
pnpm --filter @fleetadlc/console typecheck                                        # tsc --noEmit
pnpm --filter @fleetadlc/console build                                            # next build, which type-checks as well
```

- **No bridge.** `vitest.config.mts` supplies the `@/` alias and the JSX
  transform. Most component tests render with `renderToStaticMarkup` and assert
  on the HTML. A test that needs effects or events starts with
  `// @vitest-environment happy-dom` and mounts with `react-dom/client`
  (`src/components/fetch-loops.test.tsx`; see docs/development.md).
- **vitest does not type-check.** Run `typecheck` or `build` after the last edit.
- **Copies are held to their source.** The console keeps its own stage titles,
  repository colours and role words; `stages.test.ts`, `repo-colors.test.ts` and
  `bot-label.test.ts` read `packages/shared/src` and fail when the two differ.
  Do not import `@fleetadlc/engines` either: its barrel pulls the CLIs into the
  client bundle.
- **Not beside the installed console.** `dev` and `start` bind 47300 and call the
  bridge on 47311 unless `FLEETADLC_CONSOLE_PORT` and `FLEETADLC_BRIDGE_URL` say
  otherwise: [docs/development.md](../../docs/development.md).

# 0082. The console knows who is looking only to key per-person browser state

- **Status:** accepted
- **Date:** 2026-11-24

## Context

The "How this works" strips (#373) remember, per strip and per person, whether
a person collapsed them, in the browser's `localStorage`. A different person
signed in on the same browser has to start with them open. The console's
client components did not know who was signed in: the root layout read
`readMe()` once per page and passed only the role down (`RoleProvider`), and
the identity the bridge answered with, `Me.email`, never reached the browser.
The console has no GitHub login for the person looking; the bridge's identity
is the IAP email behind IAP, and `OPENADLC_IDENTITY` (or `console`) on a local
install, where there is one operator.

## Decision

The root layout hands client components the identity the bridge answered
`/v1/me` with, through `ViewerProvider` (`apps/console/src/components/viewer.tsx`),
when the person is known and the email is not empty, and `null` otherwise.
`useViewerIdentity()` reads it, with `null` when no provider is above.

It is used only to key per-person browser state, as
`openadlc.<feature>.….<encoded identity>` (the strips use
`openadlc.howThisWorks.<strip>.<encoded identity>`), and never to decide what
anyone may do: the bridge decides that on every call. `null` means the default
drawing and no storage, neither read nor written.

## What this rules out

- **Each page reads `readMe()` and passes the identity as a prop.** The item
  view and the Needs you page are client components several levels below their
  server page, so the prop would thread through components that have no use
  for it. A context matches `RoleProvider`.
- **Keying per browser only, with no identity.** Simpler, as
  `alert-preferences.ts` is, but the request asked for per person: a different
  person on the same browser must start with the strips open.
- **Keeping the state on the server.** The person chose per browser when the
  request was made, and it would add a route and a table for a display choice.
- **Using the identity for anything that gates a control.** The browser's copy
  is the person's own claim to their own browser; the role, read from the same
  answer, already draws controls, and the bridge refuses what a person may not
  do whatever is drawn.

## What would make this worth revisiting

The console learning the person's GitHub login, or its identity changing from
one sign-in to the next for the same person: either would make the bridge's
identity the wrong key, and every person's remembered state would reset.
Also a feature that wants per-person state that must follow a person across
browsers, which would need the server after all.

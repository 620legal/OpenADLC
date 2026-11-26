# 0086. The Security page reads alerts as the app and shows secret scanning to admins only

- **Status:** accepted
- **Date:** 2026-11-26

## Context

OpenADLC#377 adds a Security page to the console: each managed repository's
open Dependabot, code-scanning and secret-scanning alerts, with a severity, a
link to GitHub and a File as task button. Three things made this a decision
rather than an obvious build.

- A secret-scanning alert carries the leaked secret itself, and code-scanning
  alerts point at weak spots in the code. A console `user` can read the board,
  costs, insights and health. GitHub's own default shows Dependabot and
  code-scanning alerts to people with write access, and secret-scanning alerts
  only to admins. Who may see them in the console is a policy, and a person
  answered it on the issue.
- The `app-permissions` check raises a **blocking** card for each permission in
  `MANIFEST_PERMISSIONS` the app lacks, and one on each installation that has
  not accepted a new one. Every app made before this change lacks the three
  alert permissions.
- GitHub answers 403 both when the app lacks the permission and when the
  feature is switched off on the repository, and sends
  `x-accepted-github-permissions` on either.

## Decision

- **Read as the app, GET only, nothing stored.**
  `apps/bridge/src/security-alerts.ts` reads
  `/repos/{r}/{dependabot,code-scanning,secret-scanning}/alerts?state=open`
  with an installation token scoped to that one repository. It goes through
  `SecurityReads`, whose one read is `GitHubClient.getPaged`. That method sends
  GETs, follows `Link: rel="next"` (Dependabot pages by cursor) and stops at 10
  pages with `truncated: true`. Answers are memoised for 60 seconds per
  repository and type. There is no table.
- **Allowlisted entries.** Each entry is built field by field: type,
  repository, number, title, severity, link, created at, where, and a note.
  GitHub's object is never spread. The secret-scanning read also asks
  `hide_secret=true`. A secret entry's title is `secret_type_display_name`.
  Only a link on `https://github.com/` is passed on.
- **Severity** is `critical | high | medium | low | none`. Dependabot keeps the
  advisory's word (`moderate` is medium). Code scanning uses
  `rule.security_severity_level`; when that is absent it is `none`, with
  `rule.severity` kept as a note. Secret scanning is `none`. Nothing is made up
  where GitHub gives no level.
- **Who sees what.** `GET /v1/security/alerts` is a `user` route. For a
  `user`, the reader never calls the secret-scanning endpoint and answers that
  type as `admins-only`. An admin sees all three types. The navigation shows
  Security to both roles.
- **The 403 classifier.** A 403 whose body says `Resource not accessible by
  integration` is `unreadable`, naming the permission's page label. Any other
  403, and any 404, is `off`, shown as an empty state. Anything else is
  `failed` for that one type on that one repository and never fails the page.
  Where the app is not installed, every type is `not-installed`.
- **Optional permissions, their own check.** `SECURITY_ALERT_PERMISSIONS`
  (`vulnerability_alerts`, `security_events`, `secret_scanning_alerts`, all
  read) go into the manifest's `default_permissions`, so a new app has them.
  They are not in `MANIFEST_PERMISSIONS`. The `security-alerts` health check
  (warning, every 15 minutes, `steps: ['app']`) probes each type with a
  one-alert read, using the same classifier. It fails while any repository
  answers `unreadable`, names the permission, Repository permissions and
  Read-only, and links to the app's permissions page and the installation's
  page. It clears on the first read that succeeds. A GitHub that does not
  answer makes the check throw, so its rows stand.
- **File as task.** `IntakeDialog`'s `prefill` always sets the repository. It
  fills the text, details and kind only when the form is empty. Over a draft it
  offers "Replace your draft with this alert" instead. The request is built
  from the entry alone (`securityRequest`), so it holds no secret.

## What this rules out

- **Adding the three permissions to `MANIFEST_PERMISSIONS`.** Every existing
  install would get blocking permission cards, and accept cards, for an
  optional page.
- **Telling a missing permission apart by `x-accepted-github-permissions` or
  the status.** GitHub sends both on a feature-off 403 too, so repositories
  with the feature simply switched off would show as "not readable".
- **Reading secret scanning for everyone and filtering it out for a user.**
  If the call is never made, no cache entry or log line made for a user can
  hold one.
- **Mapping code scanning's `error`/`warning`/`note` onto the scale, or ranking
  secrets.** Either would invent a severity GitHub did not give.
- **Writing to GitHub**: dismissing alerts, or the security seat's review
  findings (#378). Both are out of scope here.

## What would make this worth revisiting

- GitHub rewording "Resource not accessible by integration", or giving a
  distinct status for a missing permission. The classifier keeps the wording in
  one place.
- A wish to let users see secret-scanning alerts, or to hide code scanning from
  them. That is the role rule above, and a person decides it.
- Installs large enough that reading on each open, even memoised, presses on
  GitHub's rate limit. A stored, scheduled read would then be worth its table.

# Security policy

## Reporting a vulnerability

Report privately, not in a public issue. Use GitHub's private vulnerability
reporting on this repository: **Security → Report a vulnerability**. Only the
maintainers see the report — today that is [@orzelig](https://github.com/orzelig)
— and the fix is discussed in a private advisory before anything is public. If
that form is not available to you, write to security@620legal.com.

Please include what you found, how to reproduce it, and what an attacker could do
with it. If you have a suggested fix, say so — but do not open a public pull
request for a vulnerability before it is fixed.

Expect an acknowledgement within a few days. OpenADLC is early-stage software
maintained by a small team; there is no service level attached to this policy.

## Supported versions

Fixes land on `main`. There are no releases yet; once there are, the latest
release is supported.

## What is in scope

- Authentication and token handling: the device flow, the token broker, the secret
  store, anything that could leak a refresh token or a user token.
- Privilege boundaries: a bot doing something its role should not permit, a task
  writing outside its declared paths, a bot merging or approving.
- The console and bridge APIs: missing identity checks, unaudited privileged
  actions, injection into GitHub calls.
- The terminal path: attach tokens, session isolation, anything reaching the host.

## What is out of scope

- The behaviour of the underlying model providers.
- A self-hosted install configured contrary to this documentation (for example,
  giving a bot account admin rights, or running the `local` driver in production).
- Findings that require an attacker to already control the install's secret store
  or its database.

## Operating OpenADLC safely

OpenADLC runs agents that can comment, push branches and trigger deploys as real
accounts. Read [docs/security.md](../docs/security.md) before pointing an install at
a repository that matters. A person is in the loop only where the repository asks
for one. OpenADLC's merge line, not GitHub, merges a pull request, as the app,
once the reviewer seats whose approval it needs have approved that exact head
(the lead reviewer, a bot, which reads the other seats' reviews and decides
last; the security reviewer too for a change to how CI runs), GitHub Actions'
`ci` has passed on it, and the people AGENTS.md's Human review names for the
changed paths have approved. Production is released by the repository's
`production` environment: by its required reviewers, who are people, when the
repository chose `approval: reviewers`, or by a wait timer when it chose
`approval: auto`, the default.

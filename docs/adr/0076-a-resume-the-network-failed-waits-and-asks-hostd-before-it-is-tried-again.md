# 0076. A resume the network failed waits, and asks hostd before it is tried again

- **Status:** accepted
- **Date:** 2026-11-16

## Context

When a person answers a question, the bridge resumes the paused task through
hostd. A refusal fails the task, which needs a person to press **Try again**.
Two causes already left the task paused instead: a full host
(`retryResumeLater`), and GitHub not answering the refresh of the bot's
sign-in (`waitForGitHub`, 2 hours from the answer, said once in Needs you).

On v0.1.36 a short outage on the host failed the resume of "OK, file it" on
an intake draft with `hostd refused: fetch failed`, and nothing was filed
until a person pressed Try again (#359). That `fetch failed` was hostd's own
catch-all 500, because hostd's call out failed. The bridge never sees a bare
`fetch failed` when hostd itself does not answer: `HostdClient.call` turns
that into 502 `HOSTD_NOT_ANSWERING`, and a timeout into 504. hostd can answer
502 or 504 itself, so neither the status nor the wording tells the two apart.

A resume hostd did not answer may still have begun. hostd writes the row
`running` once the session starts, and a resumed session has the same name
as the task's first one (`sessionNameFor(skill, taskId)`). The paused row
keeps that name as `tmuxSession` (`<bot>/<session>`). A paused task has no
live session: its runner exits on pause, and tmux closes the session with it.

## Decision

- **A network failure waits like GitHub's refresh.** It is one of two things.
  hostd did not answer: `HostdClient` tags its own errors `noAnswer: true`
  (`hostdDidNotAnswer`). Or hostd answered 500 with `fetch failed`, or with a
  connection or timeout code (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`,
  `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_SOCKET`, `socket hang up`, `aborted due
  to timeout`). See `resumeNetworkFailure`. Either one keeps an answered task
  paused for `resumeAnswered`, up to `RESUME_GITHUB_WAIT_MS` from the answer.
  Every other refusal fails at once, as before: any 4xx, a 500 for another
  reason, and any other 5xx. So does a resume that no answered question
  explains (a plan change approved), because no sweep would come back for it.
- **One wait, one event, with a cause.** The wait is said once, as a log line,
  a thread message and `task.resume_waits_on_github`. The event keeps its
  type, so events already stored still read. Its payload gains `cause`
  (`github` or `network`; absent means `github`) and `reason`, cut to 300
  characters. Needs you shows one `resume_waiting` card per task, worded by
  cause. The network card has no link to GitHub's status.
- **A resume hostd did not answer is tried again only once hostd shows it did
  not begin.** Before the next try, the bridge reads the row again. If the
  row is not `paused`, the resume began. Otherwise the bridge asks
  `sessions(bot)` for a live session, one that is not `stopped`, named like
  the last part of the row's `tmuxSession`. If either shows the resume
  began, the wait is cleared, nothing is resumed, and the sweep reports
  "hostd had already begun its resume". If hostd cannot be asked, or the row
  names no session, the bridge does not resume. It keeps waiting, and fails
  the task with the last reason once the wait is over. After a 500 `fetch
  failed`, hostd answered and started nothing, so the next try goes
  straight to `resumeTask`.

## What this rules out

- **Telling "hostd did not answer" by `HOSTD_NOT_ANSWERING` or the 504's
  words.** The 504 text is not exported, and hostd can answer 502 or 504
  itself. A tag is exact.
- **Reading only the task row.** The row turns `running` only after the
  session starts and the write succeeds. `sessions` covers the time in
  between.
- **A new event type for network waits.** It would split a reader that is one
  today. The existing event with a `cause` keeps stored events readable.
- **A hostd route listing starts in progress.** `startingTaskIds` is internal
  to hostd, and this change makes no hostd change. A try that times out or
  resets while hostd is still preparing the start (cloning, before
  `startSession`) shows no session, and the next sweep would post a second
  resume beside it. That window is narrow: a 504 comes only after
  `START_TIMEOUT_MS` (40 minutes), and a reset most often means hostd
  restarted and its start in progress died with it.

## What would make this worth revisiting

- A second resume is seen beside one hostd was still preparing. The fix is in
  hostd: refuse a resume of a task in `startingTasks` with a 409.
- hostd names resumed sessions differently from the task's first session, or a
  paused task keeps a live session. Then a live session with the row's name
  would no longer mean that the resume began.
- The wait is kept in memory, as GitHub's was. A bridge restart forgets
  `noAnswer`, and its first sweep resumes without asking. If restarts during
  a network wait start to matter, the wait has to be stored.

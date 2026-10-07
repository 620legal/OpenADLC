# A crew post OpenADLC did not sign

Every post the bridge makes as a crew account carries a signature
(`packages/shared/src/signature.ts`). The `unattributed-post` health check
raises a card when a post by one of those accounts does not carry one that
checks, for example "A review on exampleco/api#31 by janedoe-reviews is not
signed by OpenADLC".

An edit is judged by the account that made it. A person editing a crew
post, such as correcting an issue's Expected paths, raises no card: a
person's edit has nothing to sign. A crew account editing any post, a
person's included, must sign the new text.

The card says what the post was, where it was, and whether it counted:

- With `attributionMode: audit`, the default, unsigned posts are recorded and
  still count, except an approval from a required seat (the lead, or a seat
  marked `blocking`): an unsigned one never lands a merge, and the merge line
  says so.
- With `enforce`, an unsigned post counts for nothing: no review, no answer,
  no progress.

Every run of the check reads each recorded post again from GitHub and checks
it under the rules as they are now. A post that verifies after all is
resolved, and its card clears on its own. Posts recorded before a quoted seat
tag was read right, which once marked a post unsigned, clear this way.

The card has three buttons: **This was me**, **Open the post** and **What to
do**. What to do opens these steps beside the board.

## 1. Make sure it wasn't you

A person signed in to the bot account by hand, in a browser or with `gh`,
posts without a signature. If that was you, press **This was me**. That
dismisses the card for every post it was showing, and each dismissal is
audited (`notice.acknowledged`). Only a post nobody has dismissed brings it
back. A post that verifies after all is resolved and audited
(`attribution.resolved`).

## 2. See what it affected

Open the issue or pull request the post was on.

- **If the pull request is still open, press Hold this PR.** OpenADLC labels it
  `needs-human`, turns GitHub's auto-merge off on it, and holds `review-gate`
  pending for as long as the label is on. The merge line does not land a pull
  request with that label either (`mergeDecision`). The hold is audited
  (`pull.held`). To let it go again, remove the label on GitHub; the gate
  follows the reviews again from the next review event.
- **If it already merged**, revert it: on the pull request, choose **Revert**,
  or run `git revert <merge commit>` and open a pull request with the result.
  Then look at what shipped from it.
- **Check what else the account did.** A stolen sign-in has the account's
  write access, and nothing on GitHub stops a crew account pushing to an
  `agent/**` branch. Look at its recent pushes and branches, the pull requests
  and issues it opened or updated, and, signed in as the account, its
  security log (**Settings → Security log**).

## 3. Count only signed posts

Switch **Settings → GitHub → Signed posts** to **Count only signed posts**
(`attributionMode: enforce`). From then on an unsigned post counts for
nothing, so a stolen sign-in cannot approve a review or answer a question.
The **What to do** steps beside the board have the same switch, behind a
confirmation.

## 4. Lock the account down

Shut the intruder out first, then give OpenADLC its sign-in back, once.

1. **On GitHub, signed in as that account:**
   - Revoke the OpenADLC app's authorization: **Settings → Applications →
     Authorized GitHub Apps** → the OpenADLC app → **Revoke**. This also ends
     the sign-in OpenADLC holds, so every seat that signs in as that account
     stops until step 2.
   - Change the password, and check two-factor authentication:
     **Settings → Password and authentication**.
   - Check active sessions (**Settings → Sessions**), personal access tokens
     (**Settings → Developer settings → Personal access tokens**), and SSH and
     signing keys (**Settings → SSH and GPG keys**). Remove anything you don't
     recognise.
2. **In OpenADLC:** go to **Settings → GitHub → Connected accounts** and choose
   **Reconnect** on that account.

## 5. Pause OpenADLC until it's cleared

Stop new work from starting while you look:

- **Settings → Pause work** stops anything new from starting, across the
  whole install. Work already running finishes. The pause is kept, audited,
  and shown on the board until someone resumes it.
- Don't pause by restarting the bridge with `FLEETADLC_DISPATCH_IN_BRIDGE=0`. That
  is only for the integration suites and scripted engines. It stops builds
  alone, not intake, reviews or deploys, and Resume doesn't undo it.

When the account is secure and the posts are explained, resume work and
dismiss the card.

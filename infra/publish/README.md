# Publishing the public repository

OpenADLC was built in a private repository whose history names people,
accounts, hosts and repositories that are not to be published. A push cannot
be taken back: GitHub keeps serving pushed commits, and forks keep copies. So
the public repository, `620legal/OpenADLC`, starts from one commit of the
reviewed tree and none of that history. The private repository stays as the
archive.

## Making the commit

```bash
infra/publish/publish-fresh.sh --denylist /path/outside/the/repo <reviewed-commit> <new-directory>
```

The denylist is one extended regular expression per line, in a file that is
not in the repository. The patterns are the names of the install this tree was
built on.
They are not written here: a reader of the public repository would otherwise
have the list the script exists to keep out.

The script:

1. searches the reviewed commit's tree for those patterns, and refuses,
   writing nothing, if any is found. Read what it prints as a list to review:
   scrub those in a reviewed change first, then run it again on that commit.
   A denylist inside the repository is refused, so it cannot be archived into
   the commit;
2. runs `git archive` of that commit into the new directory, which must not
   exist yet or be empty, so nothing unreviewed goes in;
3. runs `git init` there and makes exactly one commit on `main`, authored and
   committed by `orzelig <2146989+orzelig@users.noreply.github.com>` whatever
   the machine's git configuration says, with the message `OpenADLC <version>`
   (`--message` to change it). It adds no `Signed-off-by` line, since the
   project takes no sign-off; `--signoff` adds one;
4. checks the new repository holds one commit, on `main`, by that identity, and
   no other branch;
5. adds `git@github.com:620legal/OpenADLC.git` as `origin`, and **does not
   push**. It prints the push, which pushes `main` alone:

   ```bash
   git -C <new-directory> push origin main
   ```

   Never push with `--all` or `--mirror`.

`tests/publish-fresh.test.ts` runs it against a small repository of its own,
with no network.

## What is the maintainer's

The script makes the commit. These it cannot do, and they are part of
publishing:

- **Read the commit, then push it.** `git -C <new-directory> show --stat`, then
  the push the script printed.
- **The screenshots.** The search cannot see inside an image. The
  README's `docs/images/board.png`, `item.png` and `new-request.png` were
  retaken on a scratch install with placeholder names; look at any image
  added since before the reviewed commit is chosen.
- **Email privacy.** "Keep my email addresses private" and "Block command line
  pushes that expose my email" in each account's GitHub email settings, for
  `orzelig` and for every crew account that opens pull requests, before the
  first pull request merges in the public repository. Only the account owner
  can turn them on, and until they do, merges made on GitHub are authored with
  the account's default email.
- **Keep the archive private.** The private repository is not made public,
  renamed or transferred: that would also publish its issues, pull requests,
  bot comments and Actions logs.
- **After the push**, in a fresh clone of the public repository,
  `git rev-list --all --count` prints `1`, and the authors and committers in
  `git log --all --format='%an %ae %cn %ce'` are the noreply identity alone.

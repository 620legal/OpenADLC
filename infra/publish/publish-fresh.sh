#!/usr/bin/env bash
# The public repository's first commit, made from the reviewed tree and nothing else.
#
#   infra/publish/publish-fresh.sh --denylist <file> [--message <text>] [--signoff] [--repo <path>] <reviewed-commit> <target-dir>
#
# The history this repository was built in names people, accounts, hosts and
# repositories that are not to be published, and a push cannot be taken back:
# GitHub keeps serving pushed commits and forks keep copies. So the public
# repository starts from one commit of the reviewed tree: `git archive` of that
# commit into a new directory, `git init`, one commit authored and committed by
# the maintainer's noreply identity, and the public repository as its remote.
#
# It never pushes. It prints the push for the maintainer to run, which pushes
# main alone: never `--all` or `--mirror`.
#
# Before anything is written it searches the reviewed tree for names the
# maintainer lists in a file that is not part of the tree, and refuses if any
# is found. The patterns are not in this repository: publishing them would
# publish the names.
set -euo pipefail

identity_name='orzelig'
identity_email='2146989+orzelig@users.noreply.github.com'
remote='git@github.com:620legal/OpenADLC.git'

usage() {
  cat >&2 <<'EOF'
usage: infra/publish/publish-fresh.sh --denylist <file> [--message <text>] [--signoff] [--repo <path>] <reviewed-commit> <target-dir>

  <reviewed-commit>  the commit whose tree is published (a sha, a tag or a branch)
  <target-dir>       a directory that does not exist yet, or is empty
  --denylist <file>  one extended regular expression per line, in a file that is not in the repository
  --message <text>   the commit's message (default: "OpenADLC <version>", from package.json)
  --signoff          add a Signed-off-by line (the project takes no sign-off; off by default)
  --repo <path>      the repository the commit is in (default: the one this script is in)
EOF
  exit 2
}

message=''
signoff=0
denylist=''
source_repo="$(cd "$(dirname "$0")/../.." && pwd)"
positional=()
while [ $# -gt 0 ]; do
  case "$1" in
    --denylist) [ $# -ge 2 ] || usage; denylist="$2"; shift 2 ;;
    --message) [ $# -ge 2 ] || usage; message="$2"; shift 2 ;;
    --signoff) signoff=1; shift ;;
    --repo) [ $# -ge 2 ] || usage; source_repo="$2"; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "publish-fresh: unknown option $1" >&2; usage ;;
    *) positional+=("$1"); shift ;;
  esac
done
[ ${#positional[@]} -eq 2 ] || usage
reviewed="${positional[0]}"
target="${positional[1]}"

if [ -z "$denylist" ] || [ ! -f "$denylist" ]; then
  echo "publish-fresh: --denylist must be a file kept outside this repository." >&2
  exit 2
fi
# Both paths with their symlinks resolved, so a denylist inside the repository
# is refused however it is reached: through a link to the file, or through a
# link to a directory above it.
while [ -L "$denylist" ]; do
  link="$(readlink "$denylist")"
  case "$link" in
    /*) denylist="$link" ;;
    *) denylist="$(dirname "$denylist")/$link" ;;
  esac
done
denylist="$(cd "$(dirname "$denylist")" && pwd -P)/$(basename "$denylist")"
source_real="$(cd "$source_repo" && pwd -P)"
case "$denylist" in
  "$source_real"|"$source_real"/*)
    echo "publish-fresh: the denylist is inside the repository it would be published from. Keep it outside the tree." >&2
    exit 1
    ;;
esac
# One pattern per line. Joining the lines made one expression that matched
# nothing, and the tree was published with the names still in it. Blank lines
# are dropped: an empty pattern matches every line.
patterns="$(mktemp)"
trap 'rm -f "$patterns"' EXIT
grep -v -e '^[[:space:]]*$' "$denylist" > "$patterns" || true
if [ ! -s "$patterns" ]; then
  echo "publish-fresh: the denylist is empty." >&2
  exit 2
fi

if ! sha="$(git -C "$source_repo" rev-parse --verify --quiet "${reviewed}^{commit}")"; then
  echo "publish-fresh: $reviewed is not a commit in $source_repo." >&2
  exit 1
fi

if [ -e "$target" ] && [ -n "$(ls -A "$target" 2>/dev/null)" ]; then
  echo "publish-fresh: $target is not empty. Give a new directory, so nothing else goes into the commit." >&2
  exit 1
fi

# The reviewed tree, searched before anything is written. git grep exits 1 when
# nothing matched, which is the only answer that lets this go on.
set +e
found="$(git -C "$source_repo" grep -n -iE -f "$patterns" "$sha" 2>&1)"
status=$?
set -e
if [ $status -eq 0 ]; then
  echo "publish-fresh: the tree at $sha still names the install it was built on:" >&2
  echo "$found" >&2
  echo "Scrub these in a reviewed change first, then run this again on that commit. Nothing was written." >&2
  exit 1
elif [ $status -ne 1 ]; then
  echo "publish-fresh: could not search the tree at $sha: $found" >&2
  exit 1
fi

if [ -z "$message" ]; then
  version="$(git -C "$source_repo" show "$sha:package.json" 2>/dev/null | sed -n 's/^  "version": "\([^"]*\)".*/\1/p' | head -n 1)"
  message="OpenADLC${version:+ $version}"
fi

mkdir -p "$target"
target="$(cd "$target" && pwd)"
git -C "$source_repo" archive --format=tar "$sha" | tar -x -C "$target"

git -C "$target" init --quiet --initial-branch=main
git -C "$target" add --all
# The identity is set for this commit alone, over whatever the machine's git
# configuration says, so a personal address cannot end up in it.
signoff_flag=()
[ $signoff -eq 1 ] && signoff_flag=(--signoff)
GIT_AUTHOR_NAME="$identity_name" GIT_AUTHOR_EMAIL="$identity_email" \
GIT_COMMITTER_NAME="$identity_name" GIT_COMMITTER_EMAIL="$identity_email" \
  git -C "$target" -c user.name="$identity_name" -c user.email="$identity_email" \
    commit --quiet --no-verify ${signoff_flag[@]+"${signoff_flag[@]}"} --message "$message"

# What the public repository will hold: one commit, on main, with that identity.
count="$(git -C "$target" rev-list --all --count)"
people="$(git -C "$target" log --all --format='%an <%ae> %cn <%ce>')"
branches="$(git -C "$target" for-each-ref --format='%(refname)')"
if [ "$count" != 1 ] || [ "$people" != "$identity_name <$identity_email> $identity_name <$identity_email>" ] || [ "$branches" != 'refs/heads/main' ]; then
  echo "publish-fresh: the new repository is not one commit on main by $identity_name <$identity_email>:" >&2
  git -C "$target" log --all --format='%H %an <%ae> %cn <%ce>' >&2
  exit 1
fi

git -C "$target" remote add origin "$remote"

cat <<EOF
Made $target: one commit of $sha's tree, on main, by $identity_name <$identity_email>.
Its remote is $remote. Nothing was pushed.

Read it before pushing (git -C "$target" show --stat), then push main alone:

  git -C "$target" push origin main
EOF

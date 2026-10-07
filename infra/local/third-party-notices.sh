#!/usr/bin/env bash
# Writes out the licences of the third-party software a built image installs:
# its Debian packages (/usr/share/doc/<package>/copyright), what was installed
# beside them by hand (/usr/local/share/doc, where the bot image keeps Node's
# LICENSE), every npm package anywhere in it (global ones, the engine CLIs,
# corepack's pnpm and an app's node_modules) with its LICENSE, LICENCE,
# COPYING or NOTICE files, and which package each engine CLI comes from.
#
#   infra/local/third-party-notices.sh fleetadlc-bot:latest              # to stdout
#   infra/local/third-party-notices.sh fleetadlc-bot:latest notices.txt  # to a file
#
# It reads them from the image by running it once, as root, with no network,
# and adds nothing to it: an image stays as it was built, and whoever
# publishes one runs this against it and ships the output beside it.
#
# Notices are not permission. A bot image from build-bot-image.sh holds Claude
# Code, whose licence lets you install it for your own use, not redistribute
# it; keep that image local or in a private registry
# (docs/self-hosting.md, "Third-party notices for an image you publish").
set -euo pipefail

usage() {
  cat <<'EOF'
usage: infra/local/third-party-notices.sh IMAGE [OUTPUT]

Prints the licences of what IMAGE installs (Debian packages, npm packages,
the engine CLIs), read by running IMAGE once with no network. With OUTPUT
they are written to that file instead.
EOF
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
esac
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ] || [ -z "$1" ] || [ "${1#-}" != "$1" ] || { [ "$#" -eq 2 ] && [ -z "$2" ]; }; then
  usage >&2
  exit 64
fi
image="$1"
output="${2:-}"

if ! command -v docker >/dev/null 2>&1; then
  echo "third-party-notices: docker is not installed here" >&2
  exit 69
fi
# By its id from here on, so a tag moved while this runs changes nothing.
if ! id="$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null)"; then
  echo "third-party-notices: there is no image $image here; build or pull it first" >&2
  exit 66
fi

# What runs inside the image: POSIX sh, find, sed, awk and sort, which every
# image here has, so it does not depend on the image's own Node.
read -r -d '' inside <<'INSIDE' || true
set -u
tab="$(printf '\t')"
rule='================================================================================'
section() {
  printf '\n%s\n%s\n%s\n\n' "$rule" "$1" "$rule"
}

# Each npm package's directory, once per name and version: a package.json
# right under a node_modules (or a @scope in one), or a package corepack keeps.
packages() {
  find / -xdev \( -path /proc -o -path /sys -o -path /dev \) -prune -o -type f -name package.json -print 2>/dev/null |
    awk '{
      n = split($0, parts, "/node_modules/")
      if (n > 1) {
        rel = parts[n]
        slashes = gsub(/\//, "/", rel)
        if ((substr(rel, 1, 1) == "@" && slashes == 2) || (substr(rel, 1, 1) != "@" && slashes == 1)) print
      } else if ($0 ~ /\/corepack\/(v1\/)?[^\/]+\/[^\/]+\/package\.json$/) print
    }' |
    while IFS= read -r manifest; do
      dir="${manifest%/package.json}"
      case "$dir" in
        */node_modules/*) name="${dir##*/node_modules/}" ;;
        *) name="$(sed -n 's/^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -n 1)" ;;
      esac
      version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -n 1)"
      printf '%s\t%s\t%s\n' "${name:-${dir##*/}}" "${version:-unknown}" "$dir"
    done |
    sort -t "$tab" -k1,1 -k2,2 -u
}

printf '%s\n' '# Engine CLIs'
found=""
for cli in claude codex grok; do
  path="$(command -v "$cli" 2>/dev/null)" || continue
  found=1
  real="$(readlink -f "$path" 2>/dev/null || printf '%s' "$path")"
  dir="$(dirname "$real")"
  while [ "$dir" != / ] && [ ! -f "$dir/package.json" ]; do dir="$(dirname "$dir")"; done
  if [ -f "$dir/package.json" ]; then
    printf '%s: %s, from the npm package in %s; its licence is under npm packages below\n' "$cli" "$real" "$dir"
  else
    printf '%s: %s, from no npm package\n' "$cli" "$real"
    find "$(dirname "$real")" -maxdepth 1 -type f \( -iname 'licen[cs]e*' -o -iname 'copying*' -o -iname 'notice*' \) 2>/dev/null |
      while IFS= read -r file; do section "$cli: $file"; cat "$file"; done
  fi
done
[ -n "$found" ] || printf '%s\n' 'None in this image.'

printf '\n%s\n' '# Debian packages'
if command -v dpkg-query >/dev/null 2>&1; then
  dpkg-query -W -f='${binary:Package}\t${Version}\n' | sort |
    while IFS="$tab" read -r package version; do
      name="${package%%:*}"
      section "Debian package $name $version"
      if [ -r "/usr/share/doc/$name/copyright" ]; then
        cat "/usr/share/doc/$name/copyright"
      else
        printf 'The image has no /usr/share/doc/%s/copyright.\n' "$name"
      fi
    done
else
  printf '%s\n' 'None: this image has no dpkg.'
fi

printf '\n%s\n' '# Installed outside a package manager'
others=""
for file in /usr/local/share/doc/*/*; do
  [ -f "$file" ] || continue
  others=1
  section "${file#/usr/local/share/doc/}"
  cat "$file"
done
[ -n "$others" ] || printf '%s\n' 'Nothing under /usr/local/share/doc.'

printf '\n%s\n' '# npm packages'
packages | while IFS="$tab" read -r name version dir; do
  section "npm package $name $version"
  printf 'In the image at %s\n\n' "$dir"
  files="$(find "$dir" -maxdepth 1 -type f \( -iname 'licen[cs]e*' -o -iname 'copying*' -o -iname 'notice*' \) 2>/dev/null | sort)"
  if [ -n "$files" ]; then
    printf '%s\n' "$files" | while IFS= read -r file; do
      printf -- '--- %s\n\n' "${file##*/}"
      cat "$file"
      printf '\n'
    done
  else
    license="$(sed -n 's/.*"license"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$dir/package.json" | head -n 1)"
    printf 'The package has no licence file. Its package.json says: %s\n' "${license:-nothing}"
  fi
done
INSIDE

write() {
  printf 'Third-party notices for %s\n' "$image"
  printf 'Image %s, read on %s by infra/local/third-party-notices.sh.\n' "$id" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'OpenADLC itself is under the Apache License 2.0: LICENSE and NOTICE in its repository.\n\n'
  printf '%s\n' "$inside" | docker run --rm -i --network none --user 0 --entrypoint /bin/sh "$id" -s
}

if [ -z "$output" ]; then
  write
else
  # Written beside the file and moved over it, so a failed run leaves no half list.
  partial="$output.partial"
  trap 'rm -f "$partial"' EXIT
  write > "$partial"
  mv "$partial" "$output"
  trap - EXIT
  echo "third-party-notices: wrote $output" >&2
fi

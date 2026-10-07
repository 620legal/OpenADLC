#!/usr/bin/env bash
# Installs OpenADLC on this machine and starts it, with one command:
#
#   curl -fsSL https://raw.githubusercontent.com/620legal/OpenADLC/main/infra/local/install.sh | bash
#
# or, from a checkout, infra/local/install.sh. It says what is missing and asks
# before installing it: git, Node 22+, pnpm, tmux, Docker (OrbStack on a Mac),
# cloudflared, and on Linux the compiler node-pty needs. Then it clones the
# repository, builds it, builds the bot image, writes the install (~/.fleetadlc),
# starts it and opens the console's sign-in link, where the walkthrough does the
# rest.
#
# Run it again at any time: what is there is kept, a clean checkout is brought
# up to date, and an install that is running stays running.
#
# Options (piped, pass them after `bash -s --`):
#   --dir <path>       where the checkout goes (default ~/OpenADLC, or the checkout this script is in)
#   --ref <branch>     the branch or tag to check out (default main)
#   --yes              install what is missing without asking (not: settle for the local driver)
#   --local-driver     with no Docker answering, use the local driver rather than stop
#   --no-start         build and write the install, but do not start it
#   --rebuild-image    build the bot image even when there is one
#   --dry-run          say what it would do, and change nothing
#
# Environment: OPENADLC_REPO (the repository to clone), OPENADLC_DIR, OPENADLC_REF,
# OPENADLC_DOCKER_SOCKET (where Docker's socket is, if not /var/run/docker.sock).
#
# Everything is inside `main`, which runs on the last line: piped into bash, a
# command that reads stdin (pnpm, Homebrew's installer) would otherwise read the
# rest of this script as its input, and bash would never run it.
set -euo pipefail

min_node=22
pnpm_version=10

HELP='Installs OpenADLC and starts it.

  curl -fsSL https://raw.githubusercontent.com/620legal/OpenADLC/main/infra/local/install.sh | bash
  curl -fsSL …/install.sh | bash -s -- --yes --dir ~/src/OpenADLC

  --dir <path>       where the checkout goes (default ~/OpenADLC, or the checkout this script is in)
  --ref <branch>     the branch or tag to check out (default main)
  --yes              install what is missing without asking (not: settle for the local driver)
  --local-driver     with no Docker answering, use the local driver rather than stop
  --no-start         build and write the install, but do not start it
  --rebuild-image    build the bot image even when there is one
  --dry-run          say what it would do, and change nothing'

if [ -t 1 ]; then
  bold=$'\033[1m' dim=$'\033[2m' green=$'\033[32m' red=$'\033[31m' reset=$'\033[0m'
else
  bold='' dim='' green='' red='' reset=''
fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==> %s%s\n' "$bold" "$*" "$reset"; }
ok()   { printf '  %s✓%s %s\n' "$green" "$reset" "$*"; }
note() { printf '  %s%s%s\n' "$dim" "$*" "$reset"; }
die()  { printf '\n%sinstall.sh: %s%s\n' "$red" "$*" "$reset" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Every command that changes the machine goes through `run`, so --dry-run is honest.
run() {
  if [ "$dry_run" = 1 ]; then printf '  %swould run:%s %s\n' "$dim" "$reset" "$*"; return 0; fi
  "$@"
}

# `run` in the checkout, which a dry run may not have made yet.
in_checkout() {
  if [ "$dry_run" = 1 ]; then printf '  %swould run in %s:%s %s\n' "$dim" "$dir" "$reset" "$*"; return 0; fi
  (cd "$dir" && "$@")
}

as_root() {
  if [ "$(id -u)" = 0 ]; then run "$@"
  elif have sudo; then run sudo "$@"
  else die "this needs root: $*. Install sudo, or run it as root"; fi
}

# A pipeline into a root shell: `curl … | sudo bash -`. Not `sudo -E`: a re-run's
# environment can hold FLEETADLC_WEBHOOK_SECRET or a DATABASE_URL with its
# password, and a remote installer has no business with them. Only a proxy,
# which those installers do need behind one, goes across.
pipe_to_root() {
  local url="$1"; shift
  if [ "$dry_run" = 1 ]; then printf '  %swould run:%s curl -fsSL %s | sudo %s\n' "$dim" "$reset" "$url" "$*"; return 0; fi
  # `env -i`, so even a run as root, or under `sudo -E`, hands the installer a
  # clean environment: a PATH, a proxy if there is one, and nothing else.
  local clean=(PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin DEBIAN_FRONTEND=noninteractive) name
  for name in http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY; do
    if [ -n "${!name:-}" ]; then clean+=("$name=${!name}"); fi
  done
  if [ "$(id -u)" = 0 ]; then curl -fsSL "$url" | env -i "${clean[@]}" "$@" >/dev/null
  else curl -fsSL "$url" | sudo env -i "${clean[@]}" "$@" >/dev/null; fi
}

# Piped into bash, stdin is this script, so a question is asked on the terminal.
confirm() {
  [ "$assume_yes" = 1 ] && return 0
  [ "$dry_run" = 1 ] && { note "(would ask) $1"; return 0; }
  if ! { : </dev/tty; } 2>/dev/null; then
    die "there is no terminal to ask on. Run it again with --yes to go ahead without asking: curl -fsSL … | bash -s -- --yes"
  fi
  local answer
  printf '%s [Y/n] ' "$1" >/dev/tty
  read -r answer </dev/tty || answer=n
  case "$answer" in ''|y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

node_major() { if have node; then node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; else echo 0; fi; }
node_ok() { [ "$(node_major)" -ge "$min_node" ]; }
docker_answers() { have docker && docker info >/dev/null 2>&1; }

brew_on_path() {
  local prefix
  for prefix in /opt/homebrew /usr/local; do
    if [ -x "$prefix/bin/brew" ]; then eval "$("$prefix/bin/brew" shellenv)"; return 0; fi
  done
  return 1
}

install_mac() {
  # Installed but not on this shell's PATH, as in a shell that predates it: used, not installed again.
  have brew || brew_on_path || true
  if ! have brew; then
    step "Installing Homebrew"
    note "a Mac gets OpenADLC's tools from Homebrew; its installer asks for your password"
    # At a terminal its installer asks to go on, and sudo asks for the password
    # there. With --yes, or with no terminal, it is run as its unattended form
    # (NONINTERACTIVE=1), which needs sudo to be usable without a prompt.
    local brew_script='https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh'
    if [ "$dry_run" = 1 ]; then
      if [ "$assume_yes" = 1 ]; then run env NONINTERACTIVE=1 /bin/bash -c "\$(curl -fsSL $brew_script)"
      else run /bin/bash -c "\$(curl -fsSL $brew_script)"; fi
    elif [ "$assume_yes" = 0 ] && { : </dev/tty; } 2>/dev/null; then
      /bin/bash -c "$(curl -fsSL "$brew_script")" </dev/tty
    else
      NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL "$brew_script")" </dev/null
    fi
    [ "$dry_run" = 1 ] || brew_on_path || true
    have brew || [ "$dry_run" = 1 ] || die "Homebrew did not install; see https://brew.sh"
  fi
  local formulae=()
  have git || formulae+=(git)
  node_ok || formulae+=(node)
  have tmux || formulae+=(tmux)
  have cloudflared || formulae+=(cloudflared)
  if [ ${#formulae[@]} -gt 0 ]; then
    step "Installing ${formulae[*]}"
    run brew install "${formulae[@]}"
  fi
  if ! have docker; then
    # OrbStack: a Docker that starts in seconds and is light on a laptop.
    # Docker Desktop works as well, and a Docker already here is used as it is.
    step "Installing OrbStack (Docker)"
    run brew install --cask orbstack
  fi
}

install_apt() {
  local packages=(ca-certificates curl gnupg)
  have git || packages+=(git)
  have tmux || packages+=(tmux)
  have python3 || packages+=(python3)
  have make || packages+=(make)
  have g++ || packages+=(g++)
  step "Installing ${packages[*]}"
  as_root apt-get update -qq
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${packages[@]}"
  if ! node_ok; then
    step "Installing Node $min_node (NodeSource)"
    pipe_to_root "https://deb.nodesource.com/setup_${min_node}.x" bash -
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
  fi
  if ! have cloudflared; then
    step "Installing cloudflared (Cloudflare's apt repository)"
    as_root mkdir -p --mode=0755 /usr/share/keyrings
    pipe_to_root https://pkg.cloudflare.com/cloudflare-main.gpg tee /usr/share/keyrings/cloudflare-main.gpg
    as_root sh -c "echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list"
    as_root apt-get update -qq
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cloudflared
  fi
  have docker || install_docker_linux
}

install_dnf() {
  local packages=(curl)
  have git || packages+=(git)
  have tmux || packages+=(tmux)
  have python3 || packages+=(python3)
  have make || packages+=(make)
  have g++ || packages+=(gcc-c++)
  step "Installing ${packages[*]}"
  as_root dnf install -y -q "${packages[@]}"
  if ! node_ok; then
    step "Installing Node $min_node (NodeSource)"
    pipe_to_root "https://rpm.nodesource.com/setup_${min_node}.x" bash -
    as_root dnf install -y -q nodejs
  fi
  if ! have cloudflared; then
    step "Installing cloudflared (Cloudflare's rpm repository)"
    as_root curl -fsSL https://pkg.cloudflare.com/cloudflared-ascii.repo -o /etc/yum.repos.d/cloudflared.repo
    as_root dnf install -y -q cloudflared
  fi
  have docker || install_docker_linux
}

install_docker_linux() {
  step "Installing Docker Engine (get.docker.com)"
  pipe_to_root https://get.docker.com sh
  if [ "$(id -u)" != 0 ]; then as_root usermod -aG docker "${USER:-$(id -un)}"; fi
  as_root systemctl enable --now docker
}

install_pnpm() {
  step "Installing pnpm"
  # Node 22 ships corepack, which runs the exact pnpm package.json pins; newer
  # Node does not. A Linux Node's global npm folder is root's.
  if have corepack; then
    run mkdir -p "$HOME/.local/bin"
    run corepack enable --install-directory "$HOME/.local/bin" pnpm
    export PATH="$HOME/.local/bin:$PATH"
    note "pnpm is in ~/.local/bin; add it to your PATH to run pnpm yourself"
  elif [ -w "$(npm prefix -g 2>/dev/null || echo /nonexistent)" ]; then
    run npm install -g "pnpm@$pnpm_version"
  else
    as_root npm install -g "pnpm@$pnpm_version"
  fi
}

start_docker() {
  # A dry run asks Docker, which changes nothing, but starts nothing and does
  # not wait; Docker it was about to install is taken to answer once it is.
  if [ "$dry_run" = 1 ]; then [ "$docker_planned" = 1 ] || docker_answers; return; fi
  docker_answers && return 0
  step "Starting Docker"
  # The first start of OrbStack or Docker Desktop takes up to a minute or two;
  # a Linux daemon that systemd starts answers within seconds or not at all.
  local tries=60 _
  if [ "$platform" = mac ]; then
    if [ -d /Applications/OrbStack.app ]; then open -ga OrbStack
    elif [ -d /Applications/Docker.app ]; then open -ga Docker
    fi
  else
    tries=10
    if have systemctl; then as_root systemctl start docker >/dev/null 2>&1 || true; fi
  fi
  for _ in $(seq 1 "$tries"); do docker_answers && return 0; sleep 2; done
  return 1
}

# Read whole before matching: under pipefail, a `grep -q` that stops reading
# early, or a command that exits non-zero after saying what was wanted, would
# fail the pipeline whatever grep found.
in_group() { local groups; groups=" $(id -nG "$@" 2>/dev/null || true) "; [[ "$groups" == *" docker "* ]]; }

# The group that owns a file: GNU stat, then BSD's.
group_of() { stat -c %G "$1" 2>/dev/null || stat -f %Sg "$1" 2>/dev/null || true; }

# On Linux, a daemon that refuses this user for want of its group is settled
# here, not by falling back to the local driver. Only that case: Docker said
# permission denied, on the system socket, whose group is docker, to a user
# who is not root. Root needs no group, a rootless daemon's socket is not
# gated by one, and a socket with no daemon behind it is not a group problem.
docker_group() {
  [ "$platform" != mac ] && [ "$(id -u)" != 0 ] && have docker || return 0
  case "${DOCKER_HOST:-}" in unix://*) return 0 ;; esac
  local socket="${OPENADLC_DOCKER_SOCKET:-/var/run/docker.sock}"
  [ -S "$socket" ] && [ "$(group_of "$socket")" = docker ] || return 0
  local said
  said="$(docker info 2>&1 || true)"
  [[ "$(printf '%s' "$said" | tr '[:upper:]' '[:lower:]')" == *"permission denied"* ]] || return 0
  local user="${USER:-$(id -un)}"
  if in_group "$user"; then
    die "you are in the docker group, but this shell started before you were. Log out and in (or run: newgrp docker), then run this again"
  fi
  say "  Docker is running, and $user is not in its group, so it will not answer $user."
  confirm "Add $user to the docker group?" || die "add yourself (sudo usermod -aG docker $user), log in again, then run this again"
  as_root usermod -aG docker "$user"
  # A dry run stops here too: the group takes effect only in a new login, so
  # nothing after this would run in this one.
  die "added $user to the docker group, which takes effect at your next login. Log out and in (or run: newgrp docker), then run this again"
}

# The driver install.json names now, or nothing.
stored_driver() {
  local file="${FLEETADLC_HOME:-$HOME/.fleetadlc}/install.json"
  [ -f "$file" ] || return 0
  node -e 'try { process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).driver ?? "")) } catch {}' "$file" 2>/dev/null || true
}

main() {
  repo_url="${OPENADLC_REPO:-https://github.com/620legal/OpenADLC.git}"
  ref="${OPENADLC_REF:-main}"
  dir="${OPENADLC_DIR:-}"
  assume_yes=0 start=1 rebuild_image=0 dry_run=0 allow_local=0 docker_planned=0 want_local=0
  bot_image="${IMAGE:-fleetadlc-bot:latest}"
  # Corepack otherwise stops to ask before it fetches the pnpm package.json pins.
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) dir="${2:?--dir needs a path}"; shift 2 ;;
      --ref) ref="${2:?--ref needs a branch or tag}"; shift 2 ;;
      --yes|-y) assume_yes=1; shift ;;
      --local-driver) allow_local=1; shift ;;
      --no-start) start=0; shift ;;
      --rebuild-image) rebuild_image=1; shift ;;
      --dry-run) dry_run=1; shift ;;
      -h|--help) say "$HELP"; return 0 ;;
      *) die "unknown option $1 (--help lists them)" ;;
    esac
  done

  case "$(uname -s)" in
    Darwin) platform=mac ;;
    Linux)
      if have apt-get; then platform=apt
      elif have dnf; then platform=dnf
      else platform=other; fi ;;
    *) die "OpenADLC installs on macOS and Linux, not $(uname -s). On Windows, run this inside WSL 2 (Ubuntu)" ;;
  esac

  # --- What is missing ------------------------------------------------------
  local missing=()
  have git || missing+=(git)
  node_ok || missing+=("node $min_node+")
  have pnpm || missing+=(pnpm)
  have tmux || missing+=(tmux)
  have cloudflared || missing+=(cloudflared)
  if ! have docker; then missing+=(docker); docker_planned=1; fi
  if [ "$platform" != mac ]; then
    have python3 || missing+=(python3)
    have make || missing+=(make)
    have g++ || missing+=(g++)
  fi

  step "OpenADLC installer"
  if [ ${#missing[@]} -eq 0 ]; then
    ok "git, Node $(node_major), pnpm, tmux, cloudflared and Docker are here"
  else
    say "  Missing: ${missing[*]}"
    [ "$platform" = other ] && die "this installer knows Homebrew, apt and dnf. Install those yourself (docs/self-hosting.md#requirements), then run it again"
    confirm "Install them now?" || die "nothing was installed. Install ${missing[*]} yourself, then run this again"
    case "$platform" in
      mac) install_mac ;;
      apt) install_apt ;;
      dnf) install_dnf ;;
    esac
    have pnpm || install_pnpm
  fi

  # --- Docker ---------------------------------------------------------------
  docker_ok=1
  if ! start_docker; then
    docker_ok=0
    docker_group
    say "  Docker is not answering. Without it OpenADLC uses the local driver, which runs each task on this machine as you: fine to try it, not for anything that matters (docs/self-hosting.md#requirements)."
    # --yes is for installing what is missing. Settling for a driver under which
    # a task can read every secret is a separate decision, made by name.
    if [ "$allow_local" = 1 ]; then note "this install will use the local driver, as --local-driver says"
    elif [ "$assume_yes" = 1 ]; then die "start Docker (open OrbStack or Docker Desktop) and run this again, or pass --local-driver to use the local driver"
    else confirm "Go on without Docker, on the local driver?" || die "start Docker (open OrbStack or Docker Desktop), then run this again"; fi
    want_local=1
  fi
  if [ "$docker_ok" = 1 ] && [ "$dry_run" = 0 ]; then ok "Docker answers"; fi

  # --- The checkout ---------------------------------------------------------
  # Run from inside a checkout, that checkout is the one installed.
  local here=''
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; fi
  if [ -z "$dir" ] && [ -n "$here" ] && grep -qs '"name": "fleetadlc"' "$here/../../package.json"; then
    dir="$(cd "$here/../.." && pwd)"
    step "Using the checkout at $dir"
  else
    dir="${dir:-$HOME/OpenADLC}"
    if [ -d "$dir/.git" ]; then
      step "Updating $dir"
      if [ -n "$(git -C "$dir" status --porcelain 2>/dev/null)" ]; then
        note "it has changes of its own, so it is left as it is"
      else
        run git -C "$dir" fetch --quiet origin "$ref"
        run git -C "$dir" checkout --quiet "$ref"
        run git -C "$dir" merge --quiet --ff-only FETCH_HEAD
      fi
    elif [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
      die "$dir is there and is not a checkout. Name another with --dir"
    else
      step "Cloning $repo_url into $dir"
      run git clone --quiet --branch "$ref" "$repo_url" "$dir"
    fi
  fi

  step "Installing dependencies and building (a few minutes the first time)"
  in_checkout pnpm install --frozen-lockfile
  in_checkout pnpm build
  [ "$dry_run" = 1 ] || ok "built"

  if [ "$docker_ok" = 1 ]; then
    if [ "$rebuild_image" = 0 ] && [ "$dry_run" = 0 ] && docker image inspect "$bot_image" >/dev/null 2>&1; then
      ok "the bot image $bot_image is there (--rebuild-image builds it again)"
    else
      step "Building the bot image each task runs in (several minutes the first time)"
      in_checkout env IMAGE="$bot_image" infra/local/build-bot-image.sh
    fi
  fi

  # No --driver unless the local driver was chosen above: init keeps the
  # driver an install already has, and a new one takes docker when Docker
  # answers and the bot image (built just above) is here. A flag on every run
  # would overwrite a driver somebody chose.
  step "Writing the install (${FLEETADLC_HOME:-~/.fleetadlc})"
  local before after
  before="$(stored_driver)"
  if [ "$want_local" = 1 ]; then in_checkout node apps/cli/bin/fleetadlc.mjs init --driver local
  else in_checkout node apps/cli/bin/fleetadlc.mjs init; fi
  after="$(stored_driver)"

  if [ "$start" = 0 ]; then
    step "Installed, not started"
    say "  Start it with:  cd $dir && pnpm fleetadlc up"
    return 0
  fi

  # hostd takes its driver when it starts, and up leaves a running service
  # running: a changed driver needs the stack stopped first, or it would go on
  # under the old one while this said it was running.
  if [ "$dry_run" = 0 ] && [ "$before" != "$after" ]; then
    step "Restarting, for the ${after:-new} driver"
    in_checkout node apps/cli/bin/fleetadlc.mjs down
  fi

  step "Starting OpenADLC"
  in_checkout node apps/cli/bin/fleetadlc.mjs up

  if [ "$dry_run" = 0 ]; then
    local link
    link="$(cd "$dir" && node apps/cli/bin/fleetadlc.mjs console-link 2>/dev/null | grep -Eo 'https?://[^ ]+/signin\?token=[^ ]+' | head -n 1 || true)"
    if [ -n "$link" ]; then
      if [ "$platform" = mac ]; then open "$link" >/dev/null 2>&1 || true
      elif have xdg-open && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then xdg-open "$link" >/dev/null 2>&1 || true
      fi
    fi
  fi

  step "OpenADLC is running"
  say "  Open the console link above (on a Mac it has opened already). The walkthrough"
  say "  does the rest: the GitHub App, the crew's accounts, a model account, a repository."
  say ""
  say "  In $dir:"
  say "    pnpm fleetadlc console-link   a fresh sign-in link (each works for an hour)"
  say "    pnpm fleetadlc doctor         what would break"
  say "    pnpm fleetadlc down           stop it"
}

main "$@"

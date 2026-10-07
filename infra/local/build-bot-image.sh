#!/usr/bin/env bash
#
# Builds the bot image, with the engine CLIs pinned.
#
# This exists because the image was not reproducible. `fleetadlc-bot:latest` was on
# one laptop because somebody built it by hand once, no command for it was
# written down anywhere in the repo, and the cloud host provisions no bot image
# at all — so "local and cloud behave the same" could not be true. The pins live
# here so both build the same thing.
#
# Usage:
#   infra/local/build-bot-image.sh                 # builds fleetadlc-bot:latest
#   IMAGE=eu-docker.pkg.dev/p/fleetadlc/bot:2026-09-21 infra/local/build-bot-image.sh
#
# The image holds Claude Code, whose licence lets you install it for your own
# use, not redistribute it. Push the image only to a private registry your own
# install pulls from; never publish it.
#
# hostd's weekly update runs this too, with newer versions in the variables
# below and IMAGE=fleetadlc-bot:candidate, and swaps the candidate in only once
# every tool that changed, and every model the crew uses, has answered from
# it. NODE_VERSION and GH_VERSION are set when the running image's are known,
# so a candidate that is only moving an engine CLI does not take whatever Node
# or gh the repositories published today. GH_FROM names the running image when
# gh is not moving, and its gh is copied into the candidate rather than
# downloaded (see Dockerfile.bot). These engine pins are what a fresh install
# starts from.
set -euo pipefail

# The version a tool printed equals the pin. `node --version` is `v22.20.0`.
# `gh --version`'s first line is `gh version 2.6.10 (date)`. A glob matched a
# prefix, so 2.6.1 passed when the image had 2.6.10 and the candidate was
# swapped in on the wrong pin. `--version-is <said> <want>` is the same check,
# so a test can prove that without building an image.
tool_version_is() {
  local said="$1" want="$2" got="${1}"
  case "${said}" in
    "gh version "*)
      got="${said#gh version }"
      got="${got%% *}"
      ;;
  esac
  [ "${got}" = "${want}" ]
}

# The image whose gh a build may keep, or nothing. The kept-gh stage is
# `FROM <that image>`, and only Docker's own builder sees the images on this
# host: a docker-container builder (a `docker buildx create` one) would look
# for fleetadlc-bot:latest on Docker Hub and fail the build. On such a builder gh
# comes from its apt repository instead, which has only its newest package —
# so a candidate there moves gh to the newest, or fails at the version check
# below if it cannot, rather than failing at a pull. `--gh-from <image>` is
# the same decision, so a test can prove it without building.
gh_from_for_builder() {
  local image="$1" driver
  [ -n "${image}" ] || return 0
  driver="$(docker buildx inspect 2>/dev/null | awk '/^Driver:/ { print $2; exit }')" || driver=""
  if [ -n "${driver}" ] && [ "${driver}" != "docker" ]; then
    echo "  the ${driver} builder cannot see ${image}; gh comes from its apt repository" >&2
    return 0
  fi
  printf '%s' "${image}"
}

if [ "${1:-}" = "--gh-from" ]; then
  gh_from_for_builder "${2:-}"
  exit 0
fi

if [ "${1:-}" = "--version-is" ]; then
  if tool_version_is "${2:-}" "${3:-}"; then
    exit 0
  fi
  exit 1
fi

# Pinned, not floating. A bot whose engine changed under it is a change nobody
# made and nobody can bisect.
CLAUDE_CLI="${CLAUDE_CLI:-@anthropic-ai/claude-code@2.1.282}"
CODEX_CLI="${CODEX_CLI:-@openai/codex@0.155.1}"
GROK_CLI="${GROK_CLI:-@xai-official/grok@1.0.41}"
# Empty unless an update names them. The Dockerfile then installs the major's
# current Node and the apt repository's current gh, which is a fresh install.
NODE_VERSION="${NODE_VERSION:-}"
GH_VERSION="${GH_VERSION:-}"
# The image whose gh the build keeps. Empty: gh comes from its apt repository.
GH_FROM="$(gh_from_for_builder "${GH_FROM:-}")"

IMAGE="${IMAGE:-fleetadlc-bot:latest}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The forward proxy the build's own steps leave through, as a container on
# Docker's default network sees it (`http://host.docker.internal:3128`). Unset
# on a laptop, where a build reaches the internet directly. On the cloud host
# the firewall rejects everything a container sends that is not to a private
# address, and a build step is such a container: without the proxy the weekly
# engine update's apt, curl and npm would be refused at the firewall. The build
# is not given the host's network instead, because that is also the way to the
# metadata server and the host's token, and an engine CLI's postinstall is code
# nobody here wrote. hostd passes its bots' proxy through as this.
BUILD_PROXY="${BUILD_PROXY:-}"
network_args=()
if [ -n "${BUILD_PROXY}" ]; then
  bypass="host.docker.internal,localhost,127.0.0.1"
  network_args+=(--add-host host.docker.internal:host-gateway)
  for name in HTTPS_PROXY HTTP_PROXY https_proxy http_proxy; do
    network_args+=(--build-arg "${name}=${BUILD_PROXY}")
  done
  network_args+=(--build-arg "NO_PROXY=${bypass}" --build-arg "no_proxy=${bypass}")
  # Node's fetch (corepack's) uses the proxy only when told to; see Dockerfile.bot.
  network_args+=(--build-arg "NODE_USE_ENV_PROXY=1")
fi

# What the image says it carries: package → version, as JSON, in the
# `fleetadlc.engines` label. hostd reads it to know which engines a bot runs without
# starting a container, and the weekly update compares it with npm. So a pin has
# to be a version — `@latest` or a range would put a word in the label that
# nothing can compare, and a build nobody can reproduce in the image.
engines_label() {
  local json="" spec name version
  for spec in "$@"; do
    name="${spec%@*}"
    version="${spec##*@}"
    if [ -z "${name}" ] || [ "${name}" = "${spec}" ] \
      || ! [[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
      echo "${spec} is not pinned to a version — write it as <package>@<x.y.z>" >&2
      return 1
    fi
    json="${json:+${json},}\"${name}\":\"${version}\""
  done
  printf '{%s}' "${json}"
}
label_specs=("${CLAUDE_CLI}" "${CODEX_CLI}" "${GROK_CLI}")
version_args=()
if [ -n "${NODE_VERSION}" ]; then
  label_specs+=("node@${NODE_VERSION}")
  version_args+=(--build-arg "NODE_VERSION=${NODE_VERSION}")
fi
if [ -n "${GH_VERSION}" ]; then
  label_specs+=("gh@${GH_VERSION}")
  version_args+=(--build-arg "GH_VERSION=${GH_VERSION}")
fi
if [ -n "${GH_FROM}" ]; then
  version_args+=(--build-arg "GH_FROM=${GH_FROM}")
fi
ENGINES="$(engines_label "${label_specs[@]}")"

echo "building ${IMAGE}"
echo "  ${CLAUDE_CLI}"
echo "  ${CODEX_CLI}"
echo "  ${GROK_CLI}"
if [ -n "${NODE_VERSION}" ]; then echo "  node@${NODE_VERSION}"; fi
if [ -n "${GH_VERSION}" ]; then echo "  gh@${GH_VERSION}${GH_FROM:+ (kept from ${GH_FROM})}"; fi
if [ -n "${BUILD_PROXY}" ]; then echo "  through ${BUILD_PROXY}"; fi

docker build \
  -f "${HERE}/Dockerfile.bot" \
  ${network_args[@]+"${network_args[@]}"} \
  ${version_args[@]+"${version_args[@]}"} \
  --build-arg ENGINE_CLI_PACKAGES="${CLAUDE_CLI} ${CODEX_CLI} ${GROK_CLI}" \
  --label "fleetadlc.engines=${ENGINES}" \
  -t "${IMAGE}" \
  "${HERE}"

# Proving it rather than trusting the build: an engine CLI that is not on the
# PATH inside the image fails at the moment a task runs, which is the most
# expensive place to find out. `chooseEngine` refuses, and the task dies.
echo
echo "verifying the engines are on the PATH as the bot user"
for cli in claude codex grok; do
  if docker run --rm --entrypoint sh "${IMAGE}" -c "command -v ${cli} >/dev/null"; then
    printf '  %-8s %s\n' "${cli}" "$(docker run --rm --entrypoint sh "${IMAGE}" -c "command -v ${cli}")"
  else
    echo "  ${cli} MISSING — the image built but a bot on this engine cannot run" >&2
    exit 1
  fi
done

# And that each is the version the label says: the label is what hostd reads,
# so a label that disagreed with the binary would be a bot running an engine
# nobody recorded.
echo
echo "verifying each engine is the version pinned above"
for pair in "claude ${CLAUDE_CLI##*@}" "codex ${CODEX_CLI##*@}" "grok ${GROK_CLI##*@}"; do
  cli="${pair%% *}"
  version="${pair#* }"
  said="$(docker run --rm --entrypoint sh "${IMAGE}" -c "${cli} --version" 2>/dev/null || true)"
  said="${said%%$'\n'*}"
  case "${said}" in
    *"${version}"*) printf '  %-8s %s\n' "${cli}" "${said}" ;;
    *)
      echo "  ${cli} says \"${said}\", not ${version}" >&2
      exit 1
      ;;
  esac
done

# Node and gh, when this build was asked for a version. A fresh install leaves
# them to the Dockerfile, and the label does not invent a pin it did not check.
if [ -n "${NODE_VERSION}" ]; then
  said="$(docker run --rm --entrypoint node "${IMAGE}" --version 2>/dev/null || true)"
  said="${said%%$'\n'*}"
  if tool_version_is "${said}" "v${NODE_VERSION}"; then
    printf '  %-8s %s\n' node "${said}"
  else
    echo "  node says \"${said}\", not ${NODE_VERSION}" >&2
    exit 1
  fi
fi
if [ -n "${GH_VERSION}" ]; then
  said="$(docker run --rm --entrypoint gh "${IMAGE}" --version 2>/dev/null || true)"
  said="${said%%$'\n'*}"
  if tool_version_is "${said}" "${GH_VERSION}"; then
    printf '  %-8s %s\n' gh "${said}"
  else
    echo "  gh says \"${said}\", not ${GH_VERSION}" >&2
    exit 1
  fi
fi

# An engine that updates itself is no longer the version pinned above.
if [ "$(docker run --rm --entrypoint sh "${IMAGE}" -c 'printf %s "${GROK_DISABLE_AUTOUPDATER:-}"')" = "1" ]; then
  echo "  grok's self-updater is off (GROK_DISABLE_AUTOUPDATER=1)"
else
  echo "  GROK_DISABLE_AUTOUPDATER is not 1 in the image — grok would update itself" >&2
  exit 1
fi

echo
echo "${IMAGE} is ready"

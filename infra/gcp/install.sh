#!/usr/bin/env bash
# Installs OpenADLC on Google Cloud, from Cloud Shell or any machine with the
# gcloud CLI, with one command:
#
#   curl -fsSL https://raw.githubusercontent.com/620legal/OpenADLC/main/infra/gcp/install.sh | bash -s -- --project <new-project-id>
#
# or, from a checkout, infra/gcp/install.sh --project <id>. In order, asking
# before anything that costs money or cannot be taken back:
#
#   1. checks gcloud is signed in (and Terraform's credentials), and that the
#      project exists with billing on; offers to create it (--billing-account);
#   2. clones the repository and builds the `fleetadlc` CLI;
#   3. builds the four images on Cloud Build, as a service account of the
#      install's own, into the project's Artifact Registry. Nothing is built on
#      this machine and Docker is not needed;
#   4. runs `fleetadlc cloud configure` with the project, region and you as its
#      answers' defaults; it asks for the console's domain;
#   5. runs `fleetadlc cloud plan`, then, once you say so, `apply`;
#   6. prints what is left: one DNS record, then the console's walkthrough.
#
# Run it again at any time, from this machine or another: the install's settings
# are taken from its bucket first, so configure offers them as the answers, and
# an apply changes only what they changed. docs/self-hosting.md#installing-on-a-cloud is the long form.
#
# Options (piped, after `bash -s --`):
#   --project <id>           the project, a new one for this install only (default: gcloud's)
#   --region <region>        default us-central1
#   --billing-account <id>   create the project if it does not exist, on this billing account
#   --dir <path>             where the checkout goes (default ~/OpenADLC, or the checkout this script is in)
#   --ref <branch>           the branch or tag to check out (default main)
#   --skip-images            the images are pushed already; do not build them
#   --plan-only              stop after the plan
#   --yes                    do not ask before creating the project or building; Terraform still asks before it applies
#   --dry-run                say what it would do, and change nothing
#
# Everything is inside `main`, which runs on the last line: piped into bash, a
# command that reads stdin would otherwise read the rest of this script.
set -euo pipefail

min_node=22

HELP='Installs OpenADLC on Google Cloud.

  curl -fsSL https://raw.githubusercontent.com/620legal/OpenADLC/main/infra/gcp/install.sh | bash -s -- --project <new-project-id>

  --project <id>           the project, a new one for this install only (default: gcloud'"'"'s)
  --region <region>        default us-central1
  --billing-account <id>   create the project if it does not exist, on this billing account
  --dir <path>             where the checkout goes (default ~/OpenADLC, or the checkout this script is in)
  --ref <branch>           the branch or tag to check out (default main)
  --skip-images            the images are pushed already; do not build them
  --plan-only              stop after the plan
  --yes                    do not ask before creating the project or building; Terraform still asks before it applies
  --dry-run                say what it would do, and change nothing'

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

# Every command that changes something goes through `run`, so --dry-run is honest.
run() {
  if [ "$dry_run" = 1 ]; then printf '  %swould run:%s %s\n' "$dim" "$reset" "$*"; return 0; fi
  "$@"
}

in_checkout() {
  if [ "$dry_run" = 1 ]; then printf '  %swould run in %s:%s %s\n' "$dim" "$dir" "$reset" "$*"; return 0; fi
  (cd "$dir" && "$@")
}

# A command that asks questions of its own (the CLI's prompts, Terraform's
# approval, a browser sign-in): on the terminal, since stdin is this script.
interactive() {
  if [ "$dry_run" = 1 ]; then printf '  %swould run in %s:%s %s\n' "$dim" "$dir" "$reset" "$*"; return 0; fi
  if { : </dev/tty; } 2>/dev/null; then (if [ -n "$dir" ] && [ -d "$dir" ]; then cd "$dir"; fi; "$@" </dev/tty)
  else die "$1 asks questions, and there is no terminal to ask on. Run this in a terminal"; fi
}

confirm() {
  [ "$assume_yes" = 1 ] && return 0
  [ "$dry_run" = 1 ] && { note "(would ask) $1"; return 0; }
  { : </dev/tty; } 2>/dev/null || die "there is no terminal to ask on; run it in one, or pass --yes"
  local answer
  printf '%s [Y/n] ' "$1" >/dev/tty
  read -r answer </dev/tty || answer=n
  case "$answer" in ''|y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

node_major() { if have node; then node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; else echo 0; fi; }

# --- Terraform ----------------------------------------------------------------

min_terraform=1.6

# Whether `terraform` is Terraform, and new enough. Being on PATH is not enough:
# Cloud Shell's /google/bin/terraform is a placeholder that prints how to
# install Terraform and exits 0, so a plan and an apply "passed" there with
# nothing created, and the install printed its last steps as if it were done.
terraform_ok() {
  have terraform || return 1
  local first major minor
  first="$(terraform version 2>/dev/null | head -n 1 || true)"
  case "$first" in "Terraform v"[0-9]*) ;; *) return 1 ;; esac
  major="${first#Terraform v}"; major="${major%%.*}"
  minor="${first#Terraform v*.}"; minor="${minor%%.*}"
  [ "$major" -gt "${min_terraform%%.*}" ] || { [ "$major" = "${min_terraform%%.*}" ] && [ "$minor" -ge "${min_terraform#*.}" ]; }
}

# HashiCorp's release of Terraform into ~/.local/bin, which a Cloud Shell keeps
# across sessions (only the home directory survives there). The version is the
# one HashiCorp's checkpoint service calls current, unless
# OPENADLC_TERRAFORM_VERSION names one; the zip is checked against the release's
# SHA256SUMS before anything is unpacked.
download_terraform() {
  local os arch version base zip work bin="$HOME/.local/bin"
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) die "install Terraform $min_terraform or later: https://developer.hashicorp.com/terraform/install" ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) die "install Terraform $min_terraform or later for $(uname -m): https://developer.hashicorp.com/terraform/install" ;; esac
  for tool in curl unzip; do have "$tool" || die "installing Terraform needs $tool. Install it, or Terraform $min_terraform or later yourself: https://developer.hashicorp.com/terraform/install"; done
  version="${OPENADLC_TERRAFORM_VERSION:-}"
  if [ -z "$version" ] && [ "$dry_run" = 0 ]; then
    version="$(curl -fsSL https://checkpoint-api.hashicorp.com/v1/check/terraform | sed -n 's/.*"current_version":"\([0-9][0-9.]*\)".*/\1/p')" || true
    [ -n "$version" ] || die "could not ask HashiCorp which Terraform is current. Name one with OPENADLC_TERRAFORM_VERSION=<version> and run this again"
  fi
  version="${version:-<current>}"
  base="https://releases.hashicorp.com/terraform/$version"
  zip="terraform_${version}_${os}_${arch}.zip"
  confirm "Install Terraform $version from releases.hashicorp.com into $bin?" || die "install Terraform $min_terraform or later: https://developer.hashicorp.com/terraform/install"
  if [ "$dry_run" = 1 ]; then
    note "would download $base/$zip, check it against SHA256SUMS, and unpack terraform into $bin"
  else
    work="$(mktemp -d)"
    curl -fsSL -o "$work/$zip" "$base/$zip" || die "could not download $base/$zip"
    curl -fsSL -o "$work/SHA256SUMS" "$base/terraform_${version}_SHA256SUMS" || die "could not download the checksums for Terraform $version"
    grep " $zip\$" "$work/SHA256SUMS" > "$work/expected" || die "Terraform $version's checksums do not list $zip"
    if have sha256sum; then (cd "$work" && sha256sum -c --status expected) || die "the Terraform download does not match its checksum; nothing was installed"
    else (cd "$work" && shasum -a 256 -c -s expected) || die "the Terraform download does not match its checksum; nothing was installed"; fi
    mkdir -p "$bin"
    unzip -o -q "$work/$zip" terraform -d "$bin"
    chmod 755 "$bin/terraform"
    rm -rf "$work"
  fi
  export PATH="$bin:$PATH"
  hash -r
}

ensure_terraform() {
  # One this script installed on an earlier run, ahead of Cloud Shell's placeholder.
  if [ -x "$HOME/.local/bin/terraform" ]; then export PATH="$HOME/.local/bin:$PATH"; hash -r; fi
  terraform_ok && return 0
  if have terraform; then
    note "the terraform here ($(command -v terraform)) is not Terraform $min_terraform or later; Cloud Shell's is only a placeholder"
  fi
  if [ "$(uname -s)" = Darwin ] && have brew; then
    confirm "Terraform $min_terraform or later is missing. Install it with Homebrew?" || die "install Terraform $min_terraform or later: https://developer.hashicorp.com/terraform/install"
    run brew install hashicorp/tap/terraform
  else
    download_terraform
  fi
  [ "$dry_run" = 1 ] || terraform_ok || die "Terraform was installed but $(command -v terraform || echo terraform) still is not Terraform $min_terraform or later. Put $HOME/.local/bin first on PATH and run this again"
}

# --- Tools ------------------------------------------------------------------

ensure_tools() {
  step "Tools"
  if ! have gcloud; then
    if [ "$(uname -s)" = Darwin ] && have brew; then
      confirm "The gcloud CLI is missing. Install it with Homebrew?" || die "install the gcloud CLI: https://cloud.google.com/sdk/docs/install"
      run brew install --cask google-cloud-sdk
    else
      die "this needs the gcloud CLI: https://cloud.google.com/sdk/docs/install (or run it in Cloud Shell, which has it: https://shell.cloud.google.com)"
    fi
  fi
  ensure_terraform
  if [ "$(node_major)" -lt "$min_node" ]; then
    # Cloud Shell has nvm, and a Node older than the CLI needs.
    if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
      # shellcheck disable=SC1091
      . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
      run nvm install "$min_node" >/dev/null
      [ "$dry_run" = 1 ] || nvm use "$min_node" >/dev/null
    elif [ "$(uname -s)" = Darwin ] && have brew; then
      run brew install node
    else
      die "this needs Node $min_node or later: https://nodejs.org (or nvm install $min_node)"
    fi
  fi
  if ! have pnpm; then
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    if have corepack; then
      run mkdir -p "$HOME/.local/bin"
      run corepack enable --install-directory "$HOME/.local/bin" pnpm
      export PATH="$HOME/.local/bin:$PATH"
    else
      run npm install -g pnpm@10
    fi
  fi
  ok "gcloud, Terraform, Node $(node_major) and pnpm"
}

# --- Google Cloud account and project ----------------------------------------

# Cloud Shell sets CLOUD_SHELL=true in its sessions.
in_cloud_shell() { [ "${CLOUD_SHELL:-}" = true ]; }

ensure_signed_in() {
  step "Signing in to Google Cloud"
  account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1 || true)"
  if [ -z "$account" ] && in_cloud_shell; then
    # A new Cloud Shell session has no account until the person clicks
    # Authorize on the browser's prompt, which the first call that needs a
    # credential raises and waits on. `gcloud auth login` there only asks
    # whether to sign in again although "already authenticated", and a no
    # stopped the install.
    note "Cloud Shell asks for your permission in the browser: click Authorize there"
    gcloud auth print-access-token >/dev/null 2>&1 || true
    account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1 || true)"
    [ -n "$account" ] || [ "$dry_run" = 1 ] || die "Cloud Shell has no Google account to act as. Click Authorize on its prompt (reload the page if there is none), then run this again"
  elif [ -z "$account" ]; then
    interactive gcloud auth login
    account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1 || true)"
  fi
  [ -n "$account" ] || [ "$dry_run" = 1 ] || die "gcloud is not signed in"
  ok "gcloud as ${account:-<you>}"
  # Terraform signs in with Application Default Credentials, which are not
  # gcloud's own. Cloud Shell has them; a laptop gets them once, in a browser.
  if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then
    in_cloud_shell && die "Cloud Shell has no credentials for Terraform. Click Authorize on its prompt (reload the page if there is none), then run this again"
    note "Terraform needs Application Default Credentials; a browser opens to sign in"
    interactive gcloud auth application-default login
  fi
  ok "Terraform's credentials"
}

ensure_project() {
  step "The project"
  project="${project:-$(gcloud config get-value project 2>/dev/null || true)}"
  [ -n "$project" ] || die "name the project: --project <id>. Use a new one, for this install only (docs/self-hosting.md#one-install-per-project)"
  if gcloud projects describe "$project" --format='value(projectId)' >/dev/null 2>&1; then
    ok "$project exists"
  else
    say "  $project does not exist (or you cannot see it)."
    if [ -z "$billing_account" ]; then
      local accounts count
      accounts="$(gcloud billing accounts list --filter=open=true --format='value(name.basename())' 2>/dev/null || true)"
      count="$(printf '%s' "$accounts" | grep -c . || true)"
      if [ "$count" = 1 ]; then billing_account="$accounts"
      else
        say "  Your billing accounts:"
        gcloud billing accounts list --filter=open=true 2>/dev/null | sed 's/^/    /' || true
        die "name the billing account to create $project on: --billing-account <id>"
      fi
    fi
    confirm "Create project $project on billing account $billing_account?" || die "nothing was created"
    run gcloud projects create "$project"
    run gcloud billing projects link "$project" --billing-account "$billing_account"
  fi
  if [ "$dry_run" = 0 ] && [ "$(gcloud billing projects describe "$project" --format='value(billingEnabled)' 2>/dev/null)" != True ]; then
    die "billing is off on $project; an install needs it (Cloud SQL, the VM). Link one: gcloud billing projects link $project --billing-account <id>"
  fi
  ok "billing is on"
  run gcloud config set project "$project" >/dev/null 2>&1
}

# --- The checkout and the CLI ------------------------------------------------

ensure_checkout() {
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
  step "Building the fleetadlc CLI"
  in_checkout pnpm install --frozen-lockfile
  # The CLI and the packages it uses: the console and the services are built
  # into their images on Cloud Build, not here.
  in_checkout pnpm --filter '@fleetadlc/cli...' build
}

# --- Images -------------------------------------------------------------------

build_images() {
  local registry="$region-docker.pkg.dev/$project/fleetadlc"
  local builder="openadlc-image-builder"
  local builder_email="$builder@$project.iam.gserviceaccount.com"
  local source_bucket="$project-openadlc-build"

  step "Building the images on Cloud Build"
  say "  Into $registry: bridge, hostd, console and bot. About fifteen minutes, on Cloud Build's machines."
  confirm "Build them now? (Cloud Build is billed by the minute; the first 2,500 minutes of e2 builds a month are free)" || die "not built. Build them yourself (docs/self-hosting.md#installing-on-a-cloud) and run this again with --skip-images"

  run gcloud services enable artifactregistry.googleapis.com cloudbuild.googleapis.com iam.googleapis.com --project "$project"

  if ! gcloud artifacts repositories describe fleetadlc --location "$region" --project "$project" >/dev/null 2>&1; then
    run gcloud artifacts repositories create fleetadlc --repository-format=docker --location "$region" --project "$project" \
      --description "OpenADLC's images: bridge, hostd, console, bot"
  fi

  # The build runs as an account of the install's own, which may push to this
  # repository and read its own source bucket, and nothing else: Cloud Build's
  # default account is the project's Compute account, which in a new project
  # often has no roles at all, and in an old one has Editor.
  local fresh=0
  if ! gcloud iam service-accounts describe "$builder_email" --project "$project" >/dev/null 2>&1; then
    run gcloud iam service-accounts create "$builder" --project "$project" --display-name "OpenADLC image builder (Cloud Build)"
    fresh=1
  fi
  if ! gcloud storage buckets describe "gs://$source_bucket" >/dev/null 2>&1; then
    run gcloud storage buckets create "gs://$source_bucket" --project "$project" --location "$region" \
      --uniform-bucket-level-access --public-access-prevention
  fi
  # The uploaded source is only needed while a build runs. The rule is a file in
  # the checkout: gcloud storage resolves a <(…) pipe to /proc/<pid>/fd/pipe:[N]
  # and cannot open it, which stopped a fresh install here with the bucket made
  # and nothing built. It is set on every run, so a bucket left by that run gets it.
  run gcloud storage buckets update "gs://$source_bucket" --lifecycle-file="$dir/infra/gcp/build-bucket-lifecycle.json"
  run gcloud artifacts repositories add-iam-policy-binding fleetadlc --location "$region" --project "$project" \
    --member "serviceAccount:$builder_email" --role roles/artifactregistry.writer >/dev/null
  run gcloud storage buckets add-iam-policy-binding "gs://$source_bucket" \
    --member "serviceAccount:$builder_email" --role roles/storage.objectViewer >/dev/null
  run gcloud projects add-iam-policy-binding "$project" \
    --member "serviceAccount:$builder_email" --role roles/logging.logWriter --condition=None >/dev/null
  if [ "$fresh" = 1 ] && [ "$dry_run" = 0 ]; then
    note "waiting a minute for the new account's roles to reach Cloud Build"
    sleep 60
  fi

  in_checkout gcloud builds submit . --project "$project" --region "$region" \
    --config infra/gcp/cloudbuild.yaml --ignore-file infra/gcp/.gcloudignore \
    --substitutions "_REGISTRY=$registry" \
    --service-account "projects/$project/serviceAccounts/$builder_email" \
    --gcs-source-staging-dir "gs://$source_bucket/source"
  ok "images pushed to $registry"
}

# --- Configure, plan, apply ---------------------------------------------------

# Configure on a machine without this install's settings treats it as new: a
# new webhook secret, and the bucket's copy overwritten as soon as the questions
# end, before any plan. So the bucket's settings are pulled first when this
# machine has none, and another install's settings here stop the run rather
# than become the defaults for this one.
# The project an install's settings file names; non-zero when the file is not
# settings (not JSON) or names no project.
settings_project() {
  node -e '
    let read;
    try { read = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { process.exit(2); }
    const id = read && read.project_id;
    if (typeof id !== "string" || !id) process.exit(3);
    process.stdout.write(id);
  ' "$1"
}

settle_settings() {
  local home="${FLEETADLC_HOME:-$HOME/.fleetadlc}"
  local here="$home/cloud.tfvars.json"
  existing=0
  if [ -f "$here" ]; then
    local theirs
    # Configure would refuse a file it cannot read and start the settings again.
    theirs="$(settings_project "$here")" || die "$here is there but is not an install's settings (not JSON, or no project_id). Fix it or move it aside, then run this again"
    if [ "$theirs" != "$project" ]; then
      die "this machine holds the settings of the install in $theirs ($here), not $project. Run with --project $theirs, or use another FLEETADLC_HOME for this one: FLEETADLC_HOME=~/.fleetadlc-$project"
    fi
    existing=1
    ok "this machine has $project's settings"
    return 0
  fi

  local bucket="$project-fleetadlc-tfstate"
  local said
  if said="$(gcloud storage objects describe "gs://$bucket/fleetadlc/cloud.tfvars.json" 2>&1 >/dev/null)"; then
    step "Taking over the settings in gs://$bucket"
    interactive node apps/cli/bin/fleetadlc.mjs cloud pull --bucket "$bucket"
    if [ "$dry_run" = 0 ]; then
      # pull checks the bucket against the project its settings name, not
      # against this run's: bucket names are global, and this one could be
      # another project's.
      local pulled
      pulled="$(settings_project "$here")" || die "the settings pulled into $here could not be read. Move it aside, then run this again"
      [ "$pulled" = "$project" ] || die "gs://$bucket holds the settings of the install in $pulled, not $project; they are now in $here. Move that file aside, then run this again with --project $pulled, or name this install's own bucket"
    fi
    existing=1
    ok "this machine has $project's settings, from gs://$bucket"
    return 0
  fi
  # A new install only when gcloud says there is nothing there. Anything else —
  # no permission, an API not enabled, the network — is not knowing, and
  # configure would then make a new webhook secret and push it over the
  # settings it could not see (the same reading as notFound in
  # apps/cli/src/commands/cloud-leftovers.ts).
  local lower
  lower="$(printf '%s' "$said" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    *not_found*|*"not found"*|*"does not exist"*) note "no settings in gs://$bucket yet: a new install" ;;
    *) die "could not tell whether gs://$bucket holds this install's settings, so nothing was configured. gcloud said: $said" ;;
  esac
}

main() {
  repo_url="${OPENADLC_REPO:-https://github.com/620legal/OpenADLC.git}"
  ref="${OPENADLC_REF:-main}"
  dir="${OPENADLC_DIR:-}"
  project='' region=us-central1 billing_account='' account='' existing=0
  assume_yes=0 dry_run=0 skip_images=0 plan_only=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --project) project="${2:?--project needs an id}"; shift 2 ;;
      --region) region="${2:?--region needs a region}"; shift 2 ;;
      --billing-account) billing_account="${2:?--billing-account needs an id}"; shift 2 ;;
      --dir) dir="${2:?--dir needs a path}"; shift 2 ;;
      --ref) ref="${2:?--ref needs a branch or tag}"; shift 2 ;;
      --skip-images) skip_images=1; shift ;;
      --plan-only) plan_only=1; shift ;;
      --yes|-y) assume_yes=1; shift ;;
      --dry-run) dry_run=1; shift ;;
      -h|--help) say "$HELP"; return 0 ;;
      *) die "unknown option $1 (--help lists them)" ;;
    esac
  done

  step "OpenADLC on Google Cloud"
  ensure_tools
  ensure_signed_in
  ensure_project
  ensure_checkout
  [ "$skip_images" = 1 ] || build_images

  settle_settings
  step "Configuring the install"
  if [ "$existing" = 1 ]; then
    say "  Each question offers what the install has now; Enter keeps it."
  else
    say "  The questions have defaults; Enter keeps one. Two need you:"
    say "    the console's domain   a name you control, e.g. openadlc.example.com (one DNS record, at the end)"
    say "    the GitHub App client id   leave it empty: the console's walkthrough makes the app"
  fi
  export FLEETADLC_CLOUD_PROJECT="$project" FLEETADLC_CLOUD_REGION="$region"
  [ -z "$account" ] || export FLEETADLC_CLOUD_CONSOLE_MEMBERS="user:$account"
  interactive node apps/cli/bin/fleetadlc.mjs cloud configure

  step "Planning"
  interactive node apps/cli/bin/fleetadlc.mjs cloud plan
  if [ "$plan_only" = 1 ]; then
    say "  Stopped after the plan. Apply it with: cd $dir && pnpm fleetadlc cloud apply"
    return 0
  fi

  step "Applying"
  note "Terraform shows the plan again and asks for yes; the first apply takes 15 to 25 minutes (Cloud SQL is most of it)"
  interactive node apps/cli/bin/fleetadlc.mjs cloud apply

  step "What is left"
  in_checkout terraform -chdir=infra/gcp output -raw next_steps || in_checkout node apps/cli/bin/fleetadlc.mjs cloud output
}

main "$@"

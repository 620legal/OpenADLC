#!/usr/bin/env bash
# A scratch install of this checkout, beside any other install on the machine.
#
#   tests/scratch.sh up      start it; build the checkout first (pnpm build)
#   tests/scratch.sh env     the exports the integration suites in tests/ read
#   tests/scratch.sh down    stop it and remove its database
#
# `fleetadlc up` starts the install FLEETADLC_HOME points at, ~/.fleetadlc by default, and on
# a machine that runs OpenADLC that is the real one. This one shares nothing with
# it: its own FLEETADLC_HOME under .scratch/, its own Postgres container and ports,
# the local driver on a tmux server of its own, engine updates off, scripted
# engines, so no model is called and nothing is written to GitHub (the
# walkthrough still asks GitHub's public API whether the bot logins it suggests
# exist), and no dispatcher in its bridge, since the suites run their own.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
scratch="${FLEETADLC_SCRATCH_DIR:-$root/.scratch}"
home="$scratch/home"
console_port="${FLEETADLC_SCRATCH_CONSOLE_PORT:-57300}"
bridge_port="${FLEETADLC_SCRATCH_BRIDGE_PORT:-57311}"
hostd_port="${FLEETADLC_SCRATCH_HOSTD_PORT:-57312}"
postgres_port="${FLEETADLC_SCRATCH_POSTGRES_PORT:-57432}"
database="${FLEETADLC_SCRATCH_DB_CONTAINER:-fleetadlc-scratch-db}"
database_url="postgres://fleetadlc:fleetadlc@127.0.0.1:${postgres_port}/fleetadlc_db"
tmux_socket="${FLEETADLC_SCRATCH_TMUX_SOCKET:-fleetadlc-scratch}"
# `local` by default. `docker` gives each task a container of its own, as a real
# install does, under names and an install label of the scratch install's own
# (`scratch-task-…`, `scratch-tasks`, `scratch-taskdb`), so nothing it makes or
# removes is another install's on the same Docker daemon.
driver="${FLEETADLC_SCRATCH_DRIVER:-local}"
case "$driver" in local|docker) ;; *) echo "FLEETADLC_SCRATCH_DRIVER is local or docker, not $driver" >&2; exit 2 ;; esac
install_id="scratch"

exports() {
  cat <<EOF
export FLEETADLC_HOME='$home'
export DATABASE_URL='$database_url'
export FLEETADLC_BRIDGE_URL='http://127.0.0.1:$bridge_port'
export FLEETADLC_HOSTD_URL='http://127.0.0.1:$hostd_port'
export FLEETADLC_CONSOLE_URL='http://127.0.0.1:$console_port'
export FLEETADLC_TMUX_BIN='$scratch/bin/tmux'
export FLEETADLC_SCRIPTED_ENGINES=1
export FLEETADLC_SCRIPTED_REPO_PATH='$home/scripted/testbed'
export FLEETADLC_BOT_PREFIX='$install_id-'
export FLEETADLC_INSTALL_ID='$install_id'
EOF
}

# Whether something answers on the port. Asked of node, which the script needs
# anyway: with lsof, a machine without it (a minimal Linux, a container) read
# every port as free, and a clash surfaced later inside `fleetadlc up`.
listening() {
  node -e 'const s = require("node:net").connect(Number(process.argv[1]), "127.0.0.1");
    s.on("connect", () => process.exit(0)); s.on("error", () => process.exit(1));' "$1"
}

up() {
  if [ ! -f "$root/apps/cli/dist/main.js" ]; then
    echo "build the checkout first: pnpm build" >&2
    exit 1
  fi
  for port in "$console_port" "$bridge_port" "$hostd_port"; do
    if listening "$port"; then
      echo "port $port is taken. Stop what uses it, or pick others with FLEETADLC_SCRATCH_*_PORT." >&2
      exit 1
    fi
  done
  mkdir -p "$home" "$scratch/bin"

  # tmux on a server of its own, so the scratch crew's sessions are never
  # another install's, and `down` can end them all.
  printf '#!/bin/sh\nexec tmux -L %s "$@"\n' "$tmux_socket" > "$scratch/bin/tmux"
  chmod +x "$scratch/bin/tmux"

  # A database of its own. Without one reachable, `fleetadlc up` would start one
  # named after this install (`scratch-db`, from FLEETADLC_INSTALL_ID), never the
  # real install's `fleetadlc-db`; starting it here first keeps it on the scratch
  # port and lets `down` remove it.
  if docker inspect "$database" > /dev/null 2>&1; then
    docker start "$database" > /dev/null
  else
    if listening "$postgres_port"; then
      echo "port $postgres_port is taken. Pick another with FLEETADLC_SCRATCH_POSTGRES_PORT." >&2
      exit 1
    fi
    docker run -d --name "$database" \
      -e POSTGRES_USER=fleetadlc -e POSTGRES_PASSWORD=fleetadlc -e POSTGRES_DB=fleetadlc_db \
      -p "127.0.0.1:$postgres_port:5432" postgres:16 > /dev/null
  fi
  for _ in $(seq 1 60); do
    if docker exec "$database" pg_isready -U fleetadlc -d fleetadlc_db > /dev/null 2>&1; then break; fi
    sleep 1
  done
  if ! docker exec "$database" pg_isready -U fleetadlc -d fleetadlc_db > /dev/null 2>&1; then
    echo "the scratch database ($database) did not become ready in 60 seconds: docker logs $database" >&2
    exit 1
  fi

  # Written once and kept, so its webhook secret, which signs the suites' own
  # deliveries, survives a restart.
  if [ ! -f "$home/install.json" ]; then
    SCRATCH_HOME="$home" ROOT="$root" DATABASE="$database_url" DRIVER="$driver" \
      CONSOLE="$console_port" BRIDGE="$bridge_port" HOSTD="$hostd_port" POSTGRES="$postgres_port" \
      node -e '
        const { randomBytes } = require("node:crypto");
        const { writeFileSync } = require("node:fs");
        const env = process.env;
        const install = {
          driver: env.DRIVER,
          organization: "",
          githubClientId: "",
          databaseUrl: env.DATABASE,
          ports: { console: +env.CONSOLE, bridge: +env.BRIDGE, hostd: +env.HOSTD, postgres: +env.POSTGRES },
          humans: [],
          repoRoot: env.ROOT,
          publicUrl: "",
          webhookSecret: randomBytes(32).toString("hex"),
        };
        writeFileSync(`${env.SCRATCH_HOME}/install.json`, JSON.stringify(install, null, 2) + "\n", { mode: 0o600 });
      '
  fi

  # Kept from the first start, except the driver, which is whatever this start asks for.
  DRIVER="$driver" FILE="$home/install.json" node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const install = JSON.parse(readFileSync(process.env.FILE, "utf8"));
    install.driver = process.env.DRIVER;
    writeFileSync(process.env.FILE, JSON.stringify(install, null, 2) + "\n", { mode: 0o600 });
  '

  eval "$(exports)"
  node "$root/apps/cli/bin/fleetadlc.mjs" up

  # Engine updates rebuild `fleetadlc-bot:latest`, the image every install on the
  # machine runs, on a weekly schedule that is on by default.
  # `/v1` is served only to the console and the CLI, which hold the console
  # secret `fleetadlc up` made; this holds it the same way.
  curl -fsS -X PATCH "http://127.0.0.1:$bridge_port/v1/engines/updates" \
    -H 'content-type: application/json' -H 'x-fleetadlc-identity: scratch' \
    -H "x-fleetadlc-console-secret: $(cat "$home/secrets/console-api-secret.secret")" \
    -d '{"enabled":false}' > /dev/null
  echo "  engine updates are off on this install"
  # Its engines are scripted, so `fleetadlc up` starts its bridge without the
  # dispatcher: the suites run their own passes, and a second dispatcher
  # deciding beside them would make them flaky.
  echo "  the bridge does not dispatch on this install; the suites do"

  echo
  echo "Scratch console: $(node "$root/apps/cli/bin/fleetadlc.mjs" console-link)"
  echo "The suites:      eval \"\$(tests/scratch.sh env)\" && node tests/all.mjs --no-live"
}

down() {
  eval "$(exports)"
  if [ -f "$home/install.json" ]; then node "$root/apps/cli/bin/fleetadlc.mjs" down || true; fi
  tmux -L "$tmux_socket" kill-server 2> /dev/null || true
  docker rm -f "$database" > /dev/null 2>&1 || true
  # What the docker driver made for its tasks: only what carries this install's label.
  if command -v docker > /dev/null 2>&1; then
    docker ps -aq --filter "label=fleetadlc.install=$install_id" | xargs docker rm -f > /dev/null 2>&1 || true
    docker network ls -q --filter "label=fleetadlc.install=$install_id" | xargs docker network rm > /dev/null 2>&1 || true
    docker network rm "$install_id-tasks" > /dev/null 2>&1 || true
    docker volume ls -q --filter "label=fleetadlc.install=$install_id" | xargs docker volume rm > /dev/null 2>&1 || true
  fi
  echo "The scratch install is stopped and its database removed. Its files are in $scratch."
}

case "${1:-}" in
  up) up ;;
  env) exports ;;
  down) down ;;
  *)
    echo "usage: tests/scratch.sh up | env | down" >&2
    exit 2
    ;;
esac

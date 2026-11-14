# 0062. Each install publishes its task database on its own port

- **Status:** accepted
- **Date:** 2026-11-14

## Context

Under the docker driver, hostd runs one Postgres server per install, `<prefix>taskdb`. Each task whose seat has `sidecarDb` gets a database on it (`apps/hostd/src/task-db.ts`).

A second install on the same machine already gets its own container name, `openadlc.install` label, ports and database. The task database server's host port was the exception: it was fixed at 47433. The second install's `docker run` failed with `port is already allocated` and left a container in `Created`. Its tasks started without a database, and `openadlc doctor` and `openadlc status` both called it healthy.

hostd retries a failed start on the next task. So whichever install's server started first held the port, and the other one could take it from the first install the next time that server was down.

Nothing outside hostd knows how the server is: the bridge runs no Docker, and `/healthz` is open and polled every few seconds.

## Decision

- install.json's `ports.taskdb` (default 47433, `DEFAULT_PORTS.taskdb`) reaches hostd as `OPENADLC_TASKDB_PORT`. It is both the published port and the port in each task's `DATABASE_URL`. The cloud host sets no variable and stays on 47433.
- hostd recreates its own container when the container's `5432/tcp` binding is not `bindAddress:port`. That covers a changed port, a changed bind address, and a container stuck in `Created` on another install's port. hostd never removes a container labelled with another install; it throws, naming the container. A failed `docker start` throws with Docker's words instead of waiting a minute on `pg_isready`.
- hostd reports the server's state on its authenticated `GET /task-database` (`idle`, `starting`, `running` or `failed`, with the error and the other containers publishing the port), never on `/healthz`. The route starts a server that is idle or failed after it has answered. The bridge's `task-database` check reads it through `HostdClient.taskDatabase()`. While a seat has `sidecarDb` and the server failed, the check raises a blocking card, "Tasks are starting without a database". `openadlc doctor` prints it like every other bridge check.
- Under the docker driver, `openadlc up` says when a container other than this install's publishes `ports.taskdb`, and exits non-zero. It still starts the services, because hostd without a task database still runs tasks.

Recreating the container loses the databases of the tasks running at that moment. They are dropped with their tasks anyway, and hostd rebuilds the template. The docs say to move the port while no task is running.

## What this rules out

- **Reporting the server in `/healthz`.** That route is open, and `up` and `status` poll it every few seconds. It would put container names on an unauthenticated route and a Docker call on every poll.
- **Doctor or the bridge running Docker themselves.** The bridge runs no Docker, and the board needs the answer as much as doctor does. hostd owns the container, so hostd reports on it.
- **Deriving the port from the install id.** It would move the default install's port, break the cloud firewall rule on 47433, and still leave a person unable to choose the port.
- **`openadlc init` picking a free port for a second install.** It picks none of the other ports either. Making all of them automatic is a separate change.

## What would make this worth revisiting

If installs stop sharing a Docker daemon — for example, each runs in its own VM or rootless daemon — the per-install port is no longer needed. Likewise if task databases come to hold something that has to outlive the container, since recreating the container on a binding mismatch would then lose more than throwaway databases.

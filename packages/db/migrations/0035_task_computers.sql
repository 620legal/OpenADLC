-- A computer per task, and more than one task at a time per seat.
--
-- A seat had one long-lived container, and one task in it at a time was the
-- collision guarantee: a second builder meant a second seat, a second GitHub
-- account and a second container. A task now gets a computer of its own, made
-- for it and removed after it, so what a seat can run at once is a number
-- (`bots.max_tasks`) rather than more seats. Two tasks of one seat share its
-- GitHub identity; they never share a computer, a worktree or a database.
--
-- Numbered 0035: 0028 to 0034 are taken by work being written beside this, and
-- migrations apply in name order whatever the gaps (`migrate.ts`).

-- Which computer a task runs in, and on which host. A container's labels are
-- fixed when it is made, so a warm container claimed for a task cannot be
-- labelled with it: this column is where hostd finds a task's container again,
-- after a restart and for the terminal. Null under the local driver.
alter table tasks add column if not exists container text;
alter table tasks add column if not exists host_id uuid references hosts(id) on delete set null;

-- How many tasks a host runs at once, whoever's they are. Each is a container
-- with its seat's CPUs and memory, so this is what the machine can hold; the
-- dispatcher and hostd both stop at it.
alter table hosts add column if not exists capacity_tasks int not null default 4;

-- How many tasks a seat runs at once (Crew → "tasks at once"), and what each
-- one's computer is given. `cpus` and `memoryGb` were read from
-- config/bots.yaml and never stored, so every container got the driver's own
-- default of two CPUs and 4 GB, whatever the file said.
alter table bots add column if not exists max_tasks int not null default 1;
alter table bots drop constraint if exists bots_max_tasks_range;
alter table bots add constraint bots_max_tasks_range check (max_tasks between 1 and 16);
alter table bots add column if not exists cpus numeric not null default 2;
alter table bots add column if not exists memory_gb numeric not null default 4;

-- One seat running the same work twice at once is never what was meant: with
-- one task per seat it could not happen, and with several it is the same
-- review or build started by two events. Anything already like that (there
-- should be nothing, since a seat could hold one live task) keeps its newest,
-- so building the index cannot fail `fleetadlc up`.
update tasks set
  state = 'stopped',
  exit_reason = 'stopped when tasks became one computer each: the same seat had this subject running twice',
  ended_at = now(),
  updated_at = now()
where id in (
  select id from (
    select id, row_number() over (partition by bot_id, subject_ref order by created_at desc) as newest
    from tasks
    where state in ('queued', 'running')
  ) live
  where live.newest > 1
);

create unique index if not exists tasks_one_live_per_bot_subject
  on tasks (bot_id, subject_ref)
  where state in ('queued', 'running');

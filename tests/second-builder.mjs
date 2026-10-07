/**
 * Adding and retiring the builder the concurrency suite adds, apart from the
 * suite itself.
 *
 * concurrency.mjs is a program: importing it runs it against the install. This
 * holds the parts a unit test needs, with the database, hostd and tmux passed in.
 */

/**
 * A second builder for the owner, and whether this call created it.
 *
 * It is the owner's next seat — `builder` gives `builder-2` — seeded the way
 * `fleetadlc up` seeds config/bots.yaml, so it is named after the seat and holds
 * no account. The dispatcher staffs a repository from every bot with the
 * owner's role, which is what makes it a second builder at all.
 *
 * A bot already in that seat belongs to whoever configured it, and may be
 * running something. It is used as it is, not written over, and `created`
 * says so, which is what keeps it from being retired at the end.
 */
export async function addSecondBuilder(owner, deps) {
  const slot = `${owner.slot.replace(/-\d+$/, '')}-2`;
  const existing = await deps.getBotBySlot(slot);
  if (existing) return { bot: existing, created: false };

  const bot = await deps.seedBot({
    slot,
    displayName: owner.displayName,
    role: owner.role,
    engine: owner.engine,
    model: owner.model,
    hostId: owner.hostId,
    skills: owner.skills,
    // A second container runs the same checks, so it needs the same database.
    sidecarDb: owner.sidecarDb,
  });
  return { bot, created: true };
}

/**
 * Retires the builder the suite created: its hostd sessions, the host tmux
 * sessions named for it, then its row.
 *
 * Deleting the row and leaving the idle shell makes `fleetadlc__<bot>__shell` a
 * session with no bot behind it. Cancelling the task leaves that shell: it is
 * created when the container comes up, and the task has a session of its own.
 * With the row gone, the console has no bot to attach the shell to.
 *
 * It takes one name and matches it exactly. It used to take every bot like
 * `<owner>-%`, which reached a real third builder from config/bots.yaml and
 * killed what it was running, and `_` in an owner's name matched any character.
 *
 * The orphans it returns are sessions that still belong to it once its row is
 * gone.
 */
export async function retireBuilder(name, deps) {
  const prefix = `fleetadlc__${name}__`;
  for (const session of await deps.listHostSessions(name)) {
    await deps.killHostSession(name, session.name);
  }
  for (const session of await deps.listTmuxSessions()) {
    if (session.startsWith(prefix)) await deps.killTmuxSession(session);
  }
  await deps.query('delete from bots where name = $1', [name]);

  const orphans = [];
  for (const session of await deps.listTmuxSessions()) {
    if (session.startsWith(prefix)) orphans.push(session);
  }
  for (const session of await deps.listHostSessions(name)) {
    orphans.push(`${name}/${session.name}`);
  }
  return orphans;
}

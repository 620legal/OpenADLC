import { audit as writeAudit, people as peopleStore, repos, routines as routineStore, type Routine, type RoutineFields } from '@openadlc/db';
import { nextRunAt, ROUTINE_TEMPLATES, validateRoutine, type RoutineTemplate } from '@openadlc/shared';
import { LINK_ACCOUNT_URL, PEOPLE_URL } from './human-review-decide.js';
import { personKey } from './person-github.js';
import { HttpFailure, type Router } from './router.js';

/**
 * The console's Routines (#369, docs/adr/0090): anyone with console access
 * reads them; creating, editing, pausing, resuming and deleting one takes a
 * linked GitHub account whose person is in People with Approves on, checked
 * here as Prepare next version checks it. Approves is per person, not a role,
 * so every route is a user's in `roles.ts`.
 *
 * Creating or editing one makes the caller its owner: a routine files as the
 * approver who last set what it says, never as someone who did not write it.
 * Pausing, resuming and deleting leave the owner as it was.
 */

export const NOT_LINKED_FOR_ROUTINES =
  'Link your GitHub account in Settings → Your GitHub account: a routine files as the person who set it, and their linked account’s Approves is checked each time it fires.';
export const APPROVES_OFF_FOR_ROUTINES = 'Only someone in People with Approves on can change routines: an admin turns it on in Settings → People.';

/** The audit actions a change writes, on `routine:<id>`. */
export const ROUTINE_CREATED = 'routine.created';
export const ROUTINE_EDITED = 'routine.edited';
export const ROUTINE_PAUSED = 'routine.paused';
export const ROUTINE_RESUMED = 'routine.resumed';
export const ROUTINE_DELETED = 'routine.deleted';

export interface RoutineRouteDeps {
  store: Pick<typeof routineStore, 'list' | 'get' | 'create' | 'update' | 'setPaused' | 'remove'>;
  /** The repositories the install manages, by name. */
  managedRepos(): Promise<{ id: string; name: string }[]>;
  /** The GitHub account linked to a console identity, as Settings shows it. */
  linkOf(identity: string): Promise<{ githubLogin: string; githubUserId: number } | null>;
  approves(githubUserId: number): Promise<boolean>;
  audit(entry: { actor: string; action: string; target: string; payload: Record<string, unknown> }): Promise<void>;
  now?: () => Date;
}

/** What `GET /v1/routines` answers. */
export interface RoutinesView {
  routines: Routine[];
  templates: readonly RoutineTemplate[];
  /** Whether this viewer may create, edit, pause, resume and delete; `why` says what to do when not. */
  mayEdit: boolean;
  why?: string;
  url?: string;
}

type Editor = { identity: string; login: string; githubId: number };

export class RoutineRoutes {
  constructor(private readonly deps: RoutineRouteDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The viewer as an editor, or why they cannot be one. */
  private async editorOf(identity: string): Promise<{ editor: Editor } | { why: string; url: string }> {
    const link = await this.deps.linkOf(personKey(identity)).catch(() => null);
    if (!link) return { why: NOT_LINKED_FOR_ROUTINES, url: LINK_ACCOUNT_URL };
    if (!(await this.deps.approves(link.githubUserId).catch(() => false))) return { why: APPROVES_OFF_FOR_ROUTINES, url: PEOPLE_URL };
    return { editor: { identity, login: link.githubLogin, githubId: link.githubUserId } };
  }

  private async editor(identity: string): Promise<Editor> {
    const who = await this.editorOf(identity);
    if ('why' in who) throw new HttpFailure(403, who.why, { url: who.url });
    return who.editor;
  }

  async view(identity: string): Promise<RoutinesView> {
    const [list, who] = await Promise.all([this.deps.store.list(), this.editorOf(identity)]);
    return { routines: list, templates: ROUTINE_TEMPLATES, ...('why' in who ? { mayEdit: false, why: who.why, url: who.url } : { mayEdit: true }) };
  }

  private async fields(body: unknown): Promise<RoutineFields> {
    const managed = await this.deps.managedRepos();
    const checked = validateRoutine(body, managed.map((repo) => repo.name));
    if (!checked.ok) throw new HttpFailure(400, checked.error, { field: checked.field });
    const { routine } = checked;
    const repo = managed.find((one) => one.name === routine.repo)!;
    return { repoId: repo.id, text: routine.text, details: routine.details, kind: routine.kind, cadence: routine.cadence, time: routine.time, timeZone: routine.timeZone };
  }

  private next(fields: Pick<RoutineFields, 'cadence' | 'time' | 'timeZone'>): Date {
    // From now: a routine set for the current minute fires on the next tick.
    return nextRunAt(this.now(), fields.cadence, fields.time, fields.timeZone);
  }

  private async record(editor: Editor, action: string, routine: Pick<Routine, 'id' | 'repo'>, payload: Record<string, unknown> = {}): Promise<void> {
    await this.deps.audit({ actor: editor.identity, action, target: `routine:${routine.id}`, payload: { repo: routine.repo, login: editor.login, ...payload } });
  }

  async create(identity: string, body: unknown): Promise<Routine> {
    const editor = await this.editor(identity);
    const fields = await this.fields(body);
    const created = await this.deps.store.create({ ...fields, owner: editor, by: identity, nextRunAt: this.next(fields) });
    await this.record(editor, ROUTINE_CREATED, created, { nextRunAt: created.nextRunAt });
    return created;
  }

  async edit(identity: string, id: string, body: unknown): Promise<Routine> {
    const editor = await this.editor(identity);
    const fields = await this.fields(body);
    const before = await this.deps.store.get(id);
    if (!before) throw new HttpFailure(404, 'There is no such routine: it may have been deleted. Reload the Routines page.');
    const edited = await this.deps.store.update(id, { ...fields, owner: editor, by: identity, nextRunAt: this.next(fields) });
    if (!edited) throw new HttpFailure(404, 'There is no such routine: it may have been deleted. Reload the Routines page.');
    await this.record(editor, ROUTINE_EDITED, edited, { previousOwner: before.owner.login, nextRunAt: edited.nextRunAt });
    return edited;
  }

  async pause(identity: string, id: string, paused: boolean): Promise<Routine> {
    const editor = await this.editor(identity);
    const current = await this.deps.store.get(id);
    if (!current) throw new HttpFailure(404, 'There is no such routine: it may have been deleted. Reload the Routines page.');
    const changed = await this.deps.store.setPaused(id, paused, paused ? null : this.next(current), identity);
    if (!changed) throw new HttpFailure(404, 'There is no such routine: it may have been deleted. Reload the Routines page.');
    await this.record(editor, paused ? ROUTINE_PAUSED : ROUTINE_RESUMED, changed, { nextRunAt: changed.nextRunAt });
    return changed;
  }

  async remove(identity: string, id: string): Promise<{ deleted: true }> {
    const editor = await this.editor(identity);
    const current = await this.deps.store.get(id);
    if (!current || !(await this.deps.store.remove(id))) throw new HttpFailure(404, 'There is no such routine: it may have been deleted. Reload the Routines page.');
    await this.record(editor, ROUTINE_DELETED, current, { text: current.text });
    return { deleted: true };
  }
}

export function liveRoutineRouteDeps(input: { linkOf: RoutineRouteDeps['linkOf'] }): RoutineRouteDeps {
  return {
    // Each read when used: the console's API registers these routes before
    // anything reads a routine, and a test's mock of the store need not carry them.
    store: {
      list: () => routineStore.list(),
      get: (id) => routineStore.get(id),
      create: (input) => routineStore.create(input),
      update: (id, input) => routineStore.update(id, input),
      setPaused: (id, paused, next, by) => routineStore.setPaused(id, paused, next, by),
      remove: (id) => routineStore.remove(id),
    },
    managedRepos: async () => (await repos.listRepos()).map((repo) => ({ id: repo.id, name: repo.name })),
    linkOf: input.linkOf,
    approves: async (githubUserId) => (await peopleStore.personByGithubId(githubUserId))?.approves === true,
    audit: async (entry) => {
      await writeAudit(entry);
    },
  };
}

export function registerRoutineRoutes(router: Router, routes: RoutineRoutes): void {
  router.get('/v1/routines', async ({ identity }) => routes.view(identity));
  router.post('/v1/routines', async ({ identity, body }) => ({ routine: await routes.create(identity, await body<unknown>()) }));
  router.patch('/v1/routines/:id', async ({ identity, params, body }) => ({ routine: await routes.edit(identity, params.id ?? '', await body<unknown>()) }));
  router.post('/v1/routines/:id/pause', async ({ identity, params }) => ({ routine: await routes.pause(identity, params.id ?? '', true) }));
  router.post('/v1/routines/:id/resume', async ({ identity, params }) => ({ routine: await routes.pause(identity, params.id ?? '', false) }));
  router.add('DELETE', '/v1/routines/:id', async ({ identity, params }) => routes.remove(identity, params.id ?? ''));
}

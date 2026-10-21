// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineUpdatesPanel, type EngineUpdatesView } from './engine-updates';
import { SelfUpdate, SelfUpdateRow, selfUpdateSentence, updateNowRefusal, wouldTakeText, type SelfUpdateView } from './self-update';

/**
 * OpenADLC's own row in Settings → System: the commit in use, the release an
 * update would take, the run in flight or the last result, and the same
 * Schedule or Manual choice and Update now as an engine's row.
 */
const VIEW: SelfUpdateView = {
  repository: '620legal/OpenADLC',
  inUse: { sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', date: '2026-10-18T09:12:00.000Z', tag: 'v0.1.0' },
  candidate: { tag: 'v0.2.0', sha: 'b'.repeat(40), publishedAt: '2026-10-20T12:00:00.000Z' },
  candidateReason: 'v0.2.0 is the newest release',
  checkedAt: '2026-10-21T10:00:00.000Z',
  schedule: { mode: 'schedule', day: 'sunday', time: '18:00' },
  timeZone: 'UTC',
  nextRun: '2026-10-25T18:00:00.000Z',
  due: false,
  applicable: true,
  reason: '',
  running: null,
  last: null,
  attention: null,
};

const RUN = {
  tag: 'v0.2.0',
  from: 'a'.repeat(40),
  to: 'b'.repeat(40),
  trigger: 'console' as const,
  actor: 'jane@example.com',
  startedAt: '2026-10-21T10:00:00.000Z',
  pid: null,
  waitingFor: [],
};

function text(view: SelfUpdateView): string {
  return renderToStaticMarkup(<ul><SelfUpdateRow view={view} busy={null} error={null} onSchedule={() => undefined} onUpdate={() => undefined} /></ul>)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

describe('the OpenADLC row', () => {
  it('names the commit in use, the release it would take and when it next runs', () => {
    const row = text(VIEW);
    expect(row).toContain('OpenADLC');
    expect(row).toContain('a1b2c3d (v0.1.0), Oct 18, 09:12');
    expect(row).toContain('would take v0.2.0, published Oct 20, 12:00');
    expect(row).toContain('next Oct 25, 18:00');
    expect(row).toContain('Not updated here yet.');
    // A tag is a deploy to every install on the schedule, and the row says so.
    expect(row).toContain('Every release tagged on 620legal/OpenADLC is deployed here at the next scheduled run, without anyone pressing anything.');
    expect(text({ ...VIEW, schedule: { ...VIEW.schedule, mode: 'manual' } })).toContain('A release on 620legal/OpenADLC is taken here only when somebody presses Update now.');
  });

  it('says why there is nothing to take, and why it cannot update at all', () => {
    expect(wouldTakeText({ ...VIEW, candidate: null, candidateReason: 'on v0.2.0, the newest release' })).toBe('on v0.2.0, the newest release');
    const refused = { ...VIEW, applicable: false, reason: 'the checkout is on mine, not main; releases are taken only onto main' };
    expect(text(refused)).toContain('the checkout is on mine, not main');
    expect(updateNowRefusal(refused)).toBe(refused.reason);
  });

  it('says each phase of a run, the tasks it waits for among them', () => {
    expect(selfUpdateSentence({ ...VIEW, running: { ...RUN, phase: 'preparing' } }).text).toMatch(/^Preparing v0\.2\.0: downloading it and checking its attestation/);
    const waiting = { ...RUN, phase: 'waiting' as const, waitingFor: [{ id: 't1', bot: 'builder', subjectRef: 'openadlc#12', kind: 'build' }, { id: 't2', bot: 'lead-reviewer', subjectRef: 'openadlc#14', kind: 'review' }] };
    expect(selfUpdateSentence({ ...VIEW, running: waiting }).text).toBe(
      'v0.2.0 is ready, and restarts the install once these 2 tasks end: builder on openadlc#12, lead-reviewer on openadlc#14. No new task starts meanwhile.',
    );
    expect(selfUpdateSentence({ ...VIEW, running: { ...RUN, phase: 'restarting' } }).text).toMatch(/^Restarting onto v0\.2\.0 now/);
  });

  it('says how the last run ended, a failure loudest', () => {
    const last = { trigger: 'schedule' as const, actor: 'schedule', from: 'a'.repeat(40), to: 'b'.repeat(40), tag: 'v0.2.0', startedAt: 't', finishedAt: '2026-10-25T18:20:00.000Z' };
    expect(selfUpdateSentence({ ...VIEW, last: { ...last, state: 'updated', reason: 'on v0.2.0' } })).toEqual({ text: 'Updated Oct 25, 18:20: aaaaaaa → v0.2.0.', tone: 'good' });
    expect(selfUpdateSentence({ ...VIEW, last: { ...last, state: 'failed', step: 'attestation', reason: 'gh attestation verify refused it. The install is as it was' } })).toEqual({
      text: 'Failed Oct 25, 18:20 at attestation: gh attestation verify refused it. The install is as it was.',
      tone: 'warn',
    });
  });

  it('disables Update now while a run is in flight, naming it', () => {
    const html = renderToStaticMarkup(<ul><SelfUpdateRow view={{ ...VIEW, running: { ...RUN, phase: 'waiting' } }} busy={null} error={null} onUpdate={() => undefined} /></ul>);
    expect(html).toMatch(/<button[^>]*title="an update to v0\.2\.0 is waiting, started by jane@example\.com"[^>]*disabled=""/);
  });

  it('is the first row of the same table as the engines', () => {
    const engines = { tools: [{ id: 'gh', name: 'GitHub CLI', inUse: '2.62.0', latest: null, pin: null, schedule: { mode: 'schedule', day: 'sunday', time: '18:00' } }], schedule: { enabled: true, day: 'sunday', time: '18:00', timeZone: 'UTC', description: '' }, nextRun: null, due: false, hostd: { reachable: true, detail: '' }, applicable: true, reason: '', image: null, inUse: null, inUseSource: null, previous: null, latest: null, running: null, last: null, hold: {}, attention: null } as unknown as EngineUpdatesView;
    const html = renderToStaticMarkup(
      <EngineUpdatesPanel
        view={engines}
        busy={null}
        error={null}
        confirming={false}
        onEnabled={() => undefined}
        onDay={() => undefined}
        onTime={() => undefined}
        onUpdate={() => undefined}
        onRollback={() => undefined}
        onConfirm={() => undefined}
        extra={<SelfUpdateRow view={VIEW} busy={null} error={null} />}
      />,
    );
    const list = html.slice(html.indexOf('<ul'), html.indexOf('</ul>'));
    expect(list.indexOf('OpenADLC')).toBeGreaterThan(-1);
    expect(list.indexOf('OpenADLC')).toBeLessThan(list.indexOf('GitHub CLI'));
  });
});

describe('the row’s controls', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the schedule as a PATCH and Update now as a POST', async () => {
    const requests: { method: string; body: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        requests.push({ method: init?.method ?? 'GET', body: String(init?.body ?? '') });
        return Response.json(VIEW);
      }),
    );
    const host = document.createElement('ul');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<SelfUpdate initial={VIEW} />));

    const mode = host.querySelector('select[aria-label="When OpenADLC updates"]') as HTMLSelectElement;
    await act(async () => {
      mode.value = 'manual';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const button = host.querySelector('button[aria-label="Update OpenADLC now"]') as HTMLButtonElement;
    await act(async () => button.click());

    expect(requests).toEqual([
      { method: 'PATCH', body: '{"mode":"manual"}' },
      { method: 'POST', body: '{}' },
    ]);
    await act(async () => root.unmount());
    host.remove();
  });
});

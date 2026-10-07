// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EngineUpdates,
  EngineUpdatesPanel,
  toolLastSentence,
  engineUpdatesTitle,
  lastResultSentence,
  nextRunSentence,
  versionChanges,
  whenDay,
  type EngineUpdateResult,
  type EngineUpdatesView,
  type SystemToolRow,
} from './engine-updates';

const CLAUDE = '@anthropic-ai/claude-code';
const CODEX = '@openai/codex';
const PINS = { [CLAUDE]: '2.1.282', [CODEX]: '0.155.1', '@xai-official/grok': '1.0.41' };
const ZONE = 'Asia/Jerusalem';

function updated(partial: Partial<EngineUpdateResult> = {}): EngineUpdateResult {
  return {
    state: 'updated',
    trigger: 'schedule',
    requestedBy: 'schedule',
    from: PINS,
    to: { ...PINS, [CLAUDE]: '2.1.290' },
    latest: { ...PINS, [CLAUDE]: '2.1.290' },
    checks: [
      { kind: 'cli', cli: 'claude', state: 'passed', detail: 'claude 2.1.290 at /home/bot/.local/bin/claude' },
      {
        kind: 'model',
        cli: 'claude',
        state: 'passed',
        model: 'claude-opus-5-5',
        configured: ['newest:opus'],
        account: { id: 'a', label: 'Anthropic Max', provider: 'anthropic', kind: 'subscription' },
        bots: ['fleetadlc-atlas-janedoe'],
        detail: 'claude-opus-5-5 (newest:opus) on Anthropic Max: answered: OK',
      },
      {
        kind: 'model',
        cli: 'codex',
        state: 'passed',
        model: 'gpt-5.5-codex',
        configured: ['newest:codex'],
        account: { id: 'b', label: 'OpenAI API key', provider: 'openai', kind: 'key' },
        bots: ['fleetadlc-cipher-janedoe'],
        detail: 'gpt-5.5-codex (newest:codex) on OpenAI API key: answered: OK',
      },
    ],
    reason: 'claude-code 2.1.282 → 2.1.290',
    // 18:02 on Sunday in Jerusalem.
    startedAt: '2026-09-27T15:00:30.000Z',
    finishedAt: '2026-09-27T15:02:00.000Z',
    refreshed: ['fleetadlc-atlas-janedoe'],
    deferred: ['fleetadlc-cipher-janedoe'],
    ...partial,
  };
}

function view(partial: Partial<EngineUpdatesView> = {}): EngineUpdatesView {
  return {
    schedule: { enabled: true, day: 'sunday', time: '18:00', timeZone: ZONE, description: 'every Sunday at 18:00' },
    nextRun: '2026-10-04T15:00:00.000Z',
    due: false,
    hostd: { reachable: true, detail: '' },
    applicable: true,
    reason: '',
    image: 'fleetadlc-bot:latest',
    inUse: { ...PINS, [CLAUDE]: '2.1.290' },
    inUseSource: 'label',
    previous: PINS,
    latest: { ...PINS, [CLAUDE]: '2.1.290', [CODEX]: '0.156.1' },
    running: null,
    last: updated(),
    hold: {},
    minReleaseAgeDays: 3,
    attention: null,
    ...partial,
  };
}

const TOOLS: SystemToolRow[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    inUse: '2.1.290',
    latest: '2.1.290',
    pin: null,
    source: 'npm',
    schedule: { mode: 'schedule', day: 'tuesday', time: '03:00' },
    nextRun: '2026-09-29T00:00:00.000Z',
    last: {
      state: 'updated',
      finishedAt: '2026-09-27T15:02:00.000Z',
      reason: 'claude-code 2.1.282 → 2.1.290',
      from: '2.1.282',
      to: '2.1.290',
      latest: '2.1.290',
      trigger: 'schedule',
    },
  },
  {
    id: 'codex',
    name: 'Codex',
    inUse: '0.155.1',
    latest: '0.156.1',
    pin: null,
    source: 'npm',
    schedule: { mode: 'manual', day: 'sunday', time: '18:00' },
    nextRun: null,
    last: null,
  },
];

function render(
  shown: EngineUpdatesView,
  options: {
    confirming?: boolean;
    onPin?: (id: string, pin: string | null) => void;
    onTimeZone?: (zone: string) => void;
    onToolSchedule?: (id: string, patch: Record<string, string>) => void;
    onUpdateTool?: (id: string) => void;
  } = {},
): string {
  const noop = () => undefined;
  return renderToStaticMarkup(
    <EngineUpdatesPanel
      view={shown}
      busy={null}
      error={null}
      confirming={options.confirming ?? false}
      onEnabled={noop}
      onDay={noop}
      onTime={noop}
      onUpdate={noop}
      onRollback={noop}
      onConfirm={noop}
      onPin={options.onPin}
      onTimeZone={options.onTimeZone}
      onToolSchedule={options.onToolSchedule}
      onUpdateTool={options.onUpdateTool}
    />,
  ).replace(/<!-- -->/g, '');
}

describe('the engine updates panel', () => {
  it('is titled with its schedule', () => {
    expect(engineUpdatesTitle(view().schedule)).toBe('Engine updates — every Sunday at 18:00');
    expect(engineUpdatesTitle({ ...view().schedule, enabled: false })).toBe('Engine updates — off');
    expect(render(view())).toContain('Engine updates — every Sunday at 18:00');
  });

  it('is titled for each tool, not with one tool’s day and time, once the tools’ schedules differ', () => {
    expect(engineUpdatesTitle(view().schedule, TOOLS)).toBe('Engine updates — each tool on its own schedule');
    const shared = TOOLS.map((tool) => ({ ...tool, schedule: { mode: 'schedule' as const, day: 'sunday', time: '18:00' } }));
    expect(engineUpdatesTitle(view().schedule, shared)).toBe('Engine updates — every Sunday at 18:00');
    expect(render(view({ tools: TOOLS }))).toContain('Engine updates — each tool on its own schedule');
  });

  it('says the last update in one sentence: when, what changed, and what it was checked against', () => {
    expect(lastResultSentence(updated(), ZONE)).toEqual({
      text: 'Sep 27, 18:02 — claude-code 2.1.282 → 2.1.290; checked against Newest Opus on Anthropic Max, Newest Codex on OpenAI API key.',
      tone: 'good',
    });
  });

  it('says a failed update did not go in, why, and that the bots kept what they had', () => {
    const sentence = lastResultSentence(
      updated({
        state: 'failed',
        reason: 'claude-opus-5-5 (newest:opus) on Anthropic Max: Invalid API key · Fix external API key',
      }),
      ZONE,
    );
    expect(sentence.tone).toBe('warn');
    expect(sentence.text).toBe(
      'Sep 27, 18:02 — claude-code 2.1.282 → 2.1.290 did not go in: claude-opus-5-5 (newest:opus) on Anthropic Max: Invalid API key · Fix external API key. The bots are still on the engines they had.',
    );
  });

  it('says a run with nothing newer, one not run, and a rollback plainly', () => {
    expect(
      lastResultSentence(updated({ state: 'current', to: null, reason: 'every engine is already the newest version' }), ZONE).text,
    ).toBe('Sep 27, 18:02 — nothing to take: every engine is already the newest version.');
    expect(
      lastResultSentence(updated({ state: 'skipped', to: null, reason: 'not applicable: the local driver runs the host’s own CLIs' }), ZONE)
        .text,
    ).toBe('Sep 27, 18:02 — not run: not applicable: the local driver runs the host’s own CLIs.');
    expect(
      lastResultSentence(updated({ state: 'rolled-back', from: { ...PINS, [CLAUDE]: '2.1.290' }, to: PINS }), ZONE).text,
    ).toBe('Sep 27, 18:02 — rolled back to the previous image: claude-code 2.1.290 → 2.1.282.');
    expect(lastResultSentence(null, ZONE)).toEqual({ text: 'No engine update has run here yet.', tone: 'plain' });
  });

  it('says when the next run is, on the install’s clock, or why there is none', () => {
    expect(nextRunSentence(view())).toBe('Next: Sunday, Oct 4 at 18:00 (Asia/Jerusalem).');
    expect(nextRunSentence(view({ due: true }))).toBe('This week’s update is due, and starts within a few minutes.');
    expect(nextRunSentence(view({ schedule: { ...view().schedule, enabled: false }, nextRun: null }))).toMatch(/^Off:/);
    expect(nextRunSentence(view({ running: { startedAt: '2026-09-27T15:00:30.000Z', trigger: 'schedule' } }))).toMatch(
      /^Updating now — started Sep 27, 18:00\./,
    );
  });

  it('shows each CLI’s version in use, and a newer one npm had', () => {
    const html = render(view());
    expect(html).toContain('claude-code');
    expect(html).toContain('2.1.290');
    expect(html).toContain('npm had 0.156.1 at the last check');
  });

  it('lists the GitHub CLI and Node, and pins a tool to the version it is on', () => {
    const html = render(
      view({
        tools: [
          {
            id: 'codex',
            name: 'Codex',
            inUse: '0.155.1',
            latest: '0.156.1',
            pin: null,
            source: 'npm',
            schedule: { mode: 'schedule', day: 'sunday', time: '18:00' },
          },
          {
            id: 'gh',
            name: 'GitHub CLI',
            inUse: '2.67.0',
            latest: '2.79.0',
            pin: '2.67.0',
            source: 'github',
            schedule: { mode: 'schedule', day: 'sunday', time: '18:00' },
          },
          {
            id: 'node',
            name: 'Node.js',
            inUse: '22.14.0',
            latest: null,
            pin: null,
            source: 'nodejs',
            schedule: { mode: 'manual', day: 'sunday', time: '18:00' },
          },
        ],
      }),
      { onPin: () => undefined, onTimeZone: () => undefined },
    );
    expect(html).toContain('>System<');
    expect(html).toContain('GitHub CLI');
    expect(html).toContain('Node.js');
    expect(html).toContain('npm had 0.156.1 at the last check');
    expect(html).toContain('the last check had 2.79.0');
    expect(html).toContain('pinned at 2.67.0');
    expect(html).toContain('aria-label="Pin Codex at 0.155.1"');
    expect(html).toContain('aria-label="Unpin GitHub CLI"');
    expect(html).toContain('aria-label="Time zone"');
    expect(html).toContain('Asia/Jerusalem');
  });

  it('gives each tool its Update choice, its own day and time, its own Update now and its last result', () => {
    const html = render(view({ tools: TOOLS }), {
      onPin: () => undefined,
      onToolSchedule: () => undefined,
      onUpdateTool: () => undefined,
    });
    expect(html).toContain('aria-label="When Claude Code updates"');
    expect(html).toContain('Automatically on a schedule');
    expect(html).toContain('Only when I press Update');
    expect(html).toContain('aria-label="Claude Code’s day"');
    expect(html).toContain('aria-label="Claude Code’s time"');
    // Manual: no day or time to choose.
    expect(html).not.toContain('aria-label="Codex’s day"');
    expect(html).toContain('aria-label="Update Claude Code now"');
    expect(html).toContain('aria-label="Update Codex now"');
    expect(html).toContain('Updated Sep 27, 18:02: 2.1.282 → 2.1.290.');
    expect(html).toContain('Not checked here yet.');
    expect(html).toContain('Update all now');
    // Each tool has its own day and time; the shared ones are gone.
    expect(html).not.toContain('aria-label="Day of the week"');
  });

  it('says one tool’s last check in a line', () => {
    const check = { finishedAt: '2026-09-27T15:02:00.000Z', trigger: 'schedule', reason: '', latest: null };
    expect(toolLastSentence(null, ZONE).text).toBe('Not checked here yet.');
    expect(toolLastSentence({ ...check, state: 'current', from: '1.0.41', to: null }, ZONE).text).toBe(
      'Checked Sep 27, 18:02: nothing newer.',
    );
    expect(
      toolLastSentence({ ...check, state: 'failed', from: '1.0.41', to: '1.0.42', reason: 'the candidate did not build' }, ZONE),
    ).toEqual({ text: 'Failed Sep 27, 18:02: the candidate did not build. It is still on 1.0.41.', tone: 'warn' });
  });

  it('offers to update now and to roll back, and asks before rolling back', () => {
    const html = render(view());
    expect(html).toContain('Update now');
    expect(html).toContain('Roll back to the previous image');
    expect(render(view(), { confirming: true })).toContain('Go back to claude-code 2.1.290 → 2.1.282?');
  });

  it('cannot roll back with no previous image, or update while a run is going', () => {
    expect(render(view({ previous: null }))).toMatch(/<button[^>]*disabled=""[^>]*title="There is no previous image/);
    expect(render(view({ running: { startedAt: '2026-09-27T15:00:30.000Z', trigger: 'schedule' } }))).toMatch(
      /<button[^>]*disabled=""[^>]*>Updating…<\/button>/,
    );
  });

  it('says what a rollback held back', () => {
    expect(render(view({ hold: { [CLAUDE]: '2.1.290' } }))).toContain('Held back after a rollback: claude-code 2.1.290.');
  });

  it('says an update that moved only Node or gh, by name, here and in what a rollback holds', () => {
    const tools = { ...PINS, node: '22.11.0', gh: '2.62.0' };
    const moved = { ...tools, node: '22.12.0', gh: '2.63.0' };
    // The engines alone were compared: "— ; checked against …".
    expect(versionChanges(tools, moved)).toBe('node 22.11.0 → 22.12.0; gh 2.62.0 → 2.63.0');
    expect(lastResultSentence(updated({ from: tools, to: moved }), ZONE).text).toMatch(/^Sep 27, 18:02 — node 22\.11\.0 → 22\.12\.0; gh 2\.62\.0 → 2\.63\.0; checked against /);
    // Nothing this console can name moved: hostd's own account of it.
    expect(lastResultSentence(updated({ from: PINS, to: PINS, reason: 'uv 0.4 → 0.5' }), ZONE).text).toMatch(/^Sep 27, 18:02 — uv 0\.4 → 0\.5; /);
    expect(render(view({ hold: { gh: '2.63.0', node: '22.12.0' } }))).toContain('Held back after a rollback: node 22.12.0, gh 2.63.0.');
  });

  it('draws the next run in a zone this browser does not know, on UTC, rather than throwing', () => {
    // The bridge checks a zone against Node's tz database, which can be newer than a browser's.
    expect(() => nextRunSentence(view({ schedule: { ...view().schedule, timeZone: 'Mars/Olympus_Mons' } }))).not.toThrow();
    expect(whenDay('2026-10-04T15:00:00.000Z', 'Mars/Olympus_Mons')).toBe('Sunday, Oct 4 at 15:00');
    expect(whenDay('not a date', ZONE)).toBe('not a date');
  });

  it('describes a change of versions by the names people use', () => {
    expect(versionChanges(PINS, { ...PINS, [CODEX]: '0.156.1' })).toBe('codex 0.155.1 → 0.156.1');
    expect(versionChanges(PINS, null)).toBe('');
  });
});

describe('the panel when hostd does not answer', () => {
  it('says what to run, and hostd’s own reason when there is one', () => {
    const html = render(view({ hostd: { reachable: false, detail: 'connect ECONNREFUSED 127.0.0.1:47302' } })).replace(/<!-- -->/g, '');
    expect(html).toContain('the versions in use are not known. Run <code class="font-mono">fleetadlc doctor</code>, or');
    expect(html).toContain('<code class="font-mono">fleetadlc up</code> if it has stopped.');
    expect(html).toContain('connect ECONNREFUSED 127.0.0.1:47302');
  });
});

describe('the System section, read again', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('drops a failed background read once a later read works', async () => {
    vi.useFakeTimers();
    const running = view({ tools: TOOLS, running: { startedAt: '2026-09-28T05:00:00.000Z', trigger: 'schedule' } });
    const answers = [new Response('bad gateway', { status: 502 }), new Response(JSON.stringify(running), { status: 200 })];
    vi.stubGlobal('fetch', vi.fn(async () => answers.shift() ?? new Response(JSON.stringify(running), { status: 200 })));
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<EngineUpdates initial={running} />));

    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(container.textContent).toContain('bad gateway');
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    // It stayed in red for the rest of the run, and after.
    expect(container.textContent).not.toContain('bad gateway');
    act(() => root.unmount());
  });

  it('takes what the page read again while nothing is in flight', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(view({ tools: TOOLS })), { status: 200 })));
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<EngineUpdates initial={view({ tools: TOOLS })} />));
    expect(container.textContent).not.toContain('Updating now');
    // Another admin pressed Update all now; the page's next read says so.
    await act(async () => root.render(<EngineUpdates initial={view({ tools: TOOLS, running: { startedAt: '2026-09-28T05:00:00.000Z', trigger: 'manual' } })} />));
    expect(container.textContent).toContain('Updating now');
    act(() => root.unmount());
  });
});

describe('the shared switch', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function drawn(shown: EngineUpdatesView): { container: HTMLElement; unmount: () => void } {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const noop = () => undefined;
    act(() =>
      root.render(
        <EngineUpdatesPanel
          view={shown}
          busy={null}
          error={null}
          confirming={false}
          onEnabled={noop}
          onDay={noop}
          onTime={noop}
          onUpdate={noop}
          onRollback={noop}
          onConfirm={noop}
          onToolSchedule={noop}
        />,
      ),
    );
    return { container, unmount: () => act(() => root.unmount()) };
  }

  const SWITCH = '[role="switch"][aria-label="Update the engines on a schedule"]';

  it('is not drawn while the tools’ schedules differ, since it would set every tool to one', () => {
    const { container, unmount } = drawn(view({ tools: TOOLS }));
    expect(container.querySelector(SWITCH)).toBeNull();
    expect(container.textContent).toContain('each is turned off or moved in its own row');
    unmount();
  });

  it('is drawn while every tool shares one schedule', () => {
    const shared = TOOLS.map((tool) => ({ ...tool, schedule: { mode: 'schedule' as const, day: 'sunday', time: '18:00' } }));
    const { container, unmount } = drawn(view({ tools: shared }));
    expect(container.querySelector(SWITCH)).not.toBeNull();
    expect(container.textContent).not.toContain('each is turned off or moved in its own row');
    unmount();
  });
});

describe('the System section’s clicks', () => {
  async function mounted(
    answer?: (method: string) => Response | null,
  ): Promise<{ sent: { method: string; body: unknown }[]; container: HTMLElement; unmount: () => void }> {
    const shown = view({ tools: TOOLS });
    const sent: { method: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        sent.push({ method, body: init?.body ? JSON.parse(String(init.body)) : null });
        return answer?.(method) ?? new Response(JSON.stringify(shown), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<EngineUpdates initial={shown} />));
    return {
      sent,
      container,
      unmount: () => {
        act(() => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
      },
    };
  }

  function button(container: HTMLElement, label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')].find(
      (one) => one.getAttribute('aria-label') === label || one.textContent === label,
    );
    if (!found) throw new Error(`no button ${label}`);
    return found;
  }

  it('updates one tool with its own Update now, and every tool with Update all now', async () => {
    const { sent, container, unmount } = await mounted();
    await act(async () => button(container, 'Update Codex now').click());
    await act(async () => button(container, 'Update all now').click());
    expect(sent).toEqual([
      { method: 'POST', body: { tools: ['codex'] } },
      { method: 'POST', body: {} },
    ]);
    unmount();
  });

  it('shows how old an engine release must be, and changes it', async () => {
    const { sent, container, unmount } = await mounted();
    const select = container.querySelector('select[aria-label="Minimum release age"]') as HTMLSelectElement;
    expect(select.value).toBe('3');
    expect(select.closest('label')?.textContent).toContain('Take an engine release once it is');
    expect([...select.options].map((option) => option.textContent)).toContain('published');
    await act(async () => {
      select.value = '7';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(sent).toEqual([{ method: 'PATCH', body: { minReleaseAgeDays: 7 } }]);
    unmount();
  });

  it('changes one tool’s Update choice, day and time, and pins the version in use', async () => {
    const { sent, container, unmount } = await mounted();
    const choose = async (label: string, value: string) => {
      const select = container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
      await act(async () => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };
    await choose('When Codex updates', 'schedule');
    await choose('Claude Code’s day', 'wednesday');
    await choose('Claude Code’s time', '04:30');
    await act(async () => button(container, 'Pin Codex at 0.155.1').click());
    expect(sent).toEqual([
      { method: 'PATCH', body: { tools: [{ id: 'codex', mode: 'schedule' }] } },
      { method: 'PATCH', body: { tools: [{ id: 'claude', day: 'wednesday' }] } },
      { method: 'PATCH', body: { tools: [{ id: 'claude', time: '04:30' }] } },
      { method: 'PATCH', body: { tools: [{ id: 'codex', pin: '0.155.1' }] } },
    ]);
    unmount();
  });

  it('says an update is already running, and reads the page again so every Update now waits for it', async () => {
    const running = view({ tools: TOOLS, running: { startedAt: '2026-09-28T05:00:00.000Z', trigger: 'schedule' } });
    const { sent, container, unmount } = await mounted((method) =>
      method === 'POST'
        ? new Response(JSON.stringify({ error: 'an update is already running; press Update now again once it has finished' }), {
            status: 409,
          })
        : new Response(JSON.stringify(running), { status: 200 }),
    );
    await act(async () => button(container, 'Update Codex now').click());
    expect(sent.map((one) => one.method)).toEqual(['POST', 'GET']);
    expect(container.textContent).toContain('an update is already running; press Update now again once it has finished');
    expect(button(container, 'Update Codex now').disabled).toBe(true);
    expect(button(container, 'Updating…').disabled).toBe(true);
    unmount();
  });
});

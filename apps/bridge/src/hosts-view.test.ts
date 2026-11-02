import { describe, expect, it } from 'vitest';
import { hostsView, type HostInput } from './hosts-view.js';

const NOW = new Date('2026-11-02T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const host = (name: string, lastSeenAt: string | null, extra: Partial<HostInput> = {}): HostInput => ({
  id: `host-${name}`,
  name,
  driver: 'docker',
  capacityTasks: 4,
  lastSeenAt,
  cpus: 8,
  memoryBytes: 17179869184,
  ...extra,
});

describe('the hosts as Settings shows them', () => {
  it('calls a host silent exactly when reconcile starts failing its tasks', () => {
    // Reconcile keeps a host whose beat is at `now - HOST_SILENT_MS` or later
    // (`>= silentBefore`), so a beat exactly five minutes old is still live.
    const view = hostsView(
      [host('a', ago(8_000)), host('b', ago(299_999)), host('c', ago(300_000)), host('d', ago(300_001)), host('e', null)],
      new Map(),
      0,
      NOW,
    );
    expect(Object.fromEntries(view.hosts.map((row) => [row.name, row.state]))).toEqual({
      a: 'live',
      b: 'live',
      c: 'live',
      d: 'silent',
      e: 'never_seen',
    });
    expect(view.silentAfterMs).toBe(300_000);
    expect(view.now).toBe('2026-11-02T12:00:00.000Z');
  });

  it('says what a silent host’s silence cost, and nothing of the others’', () => {
    const view = hostsView(
      [host('live', ago(1_000)), host('quiet', ago(600_000)), host('new', null)],
      new Map([
        ['host-live', { used: 2, failedSilent: 5 }],
        ['host-quiet', { used: 0, failedSilent: 3 }],
        ['host-new', { used: 0, failedSilent: 1 }],
      ]),
      1,
      NOW,
    );
    expect(view.hosts.map((row) => [row.name, row.used, row.failedSilent])).toEqual([
      ['live', 2, 0],
      ['quiet', 0, 3],
      ['new', 0, 0],
    ]);
    expect(view.unclaimed).toBe(1);
  });

  it('lists live hosts first, then silent, then never seen, each by name', () => {
    const view = hostsView(
      [host('zeta', null), host('beta', ago(600_000)), host('alpha', ago(600_000)), host('omega', ago(1_000)), host('gamma', ago(1_000))],
      new Map(),
      0,
      NOW,
    );
    expect(view.hosts.map((row) => row.name)).toEqual(['gamma', 'omega', 'alpha', 'beta', 'zeta']);
  });

  it('passes on what a host did not report as null, and counts no task where none holds a computer', () => {
    const [row] = hostsView([host('mac', ago(1_000), { cpus: null, memoryBytes: null })], new Map(), 0, NOW).hosts;
    expect(row).toMatchObject({ cpus: null, memoryBytes: null, used: 0, capacityTasks: 4, driver: 'docker' });
  });
});

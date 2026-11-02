// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostRow, HostsView } from '@/lib/api';
import { HostsList } from './hosts-list';

const NOW = '2026-11-02T12:00:00.000Z';
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const host = (name: string, extra: Partial<HostRow> = {}): HostRow => ({
  id: `host-${name}`,
  name,
  driver: 'docker',
  capacityTasks: 4,
  used: 0,
  cpus: 8,
  memoryBytes: 17179869184,
  lastSeenAt: ago(8_000),
  state: 'live',
  failedSilent: 0,
  ...extra,
});
const view = (hosts: HostRow[], unclaimed = 0): HostsView => ({ now: NOW, unclaimed, silentAfterMs: 300_000, hosts });

afterEach(() => {
  document.body.innerHTML = '';
});

async function mount(hosts: HostsView): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  // React's act() checks this flag before it flushes.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => createRoot(container).render(<HostsList view={hosts} />));
  return container;
}

const row = (container: HTMLElement, name: string) => container.querySelector(`[data-host="${name}"]`)?.textContent ?? '';

describe('the hosts list', () => {
  it('shows a live host’s heartbeat, its tasks against its capacity, and its size', async () => {
    const container = await mount(view([host('mac', { used: 2 })]));
    const text = row(container, 'mac');
    expect(text).toContain('mac');
    expect(text).toContain('docker');
    expect(text).toContain('seen 8 s ago');
    expect(text).toContain('2 of 4');
    expect(text).toContain('8 CPUs');
    expect(text).toContain('16 GB');
    expect(container.textContent).not.toContain('Silent');
  });

  it('says “not reported” for a size hostd has not reported', async () => {
    const container = await mount(view([host('mac', { cpus: null, memoryBytes: null })]));
    expect(row(container, 'mac')).toContain('CPUs not reported');
    expect(row(container, 'mac')).toContain('memory not reported');
  });

  it('says a silent host apart, with what its silence cost', async () => {
    const container = await mount(
      view([host('mac'), host('old', { state: 'silent', lastSeenAt: ago(12 * 60_000), failedSilent: 3 }), host('idle', { state: 'silent', lastSeenAt: ago(3_600_000) })]),
    );
    const silent = container.querySelector('[aria-labelledby="hosts-silent-title"]');
    expect(silent?.querySelector('h3')?.textContent).toBe('Silent');
    expect(silent?.textContent).not.toContain('mac');
    expect(row(container, 'old')).toContain('3 tasks were failed with “the host stopped reporting”');
    expect(row(container, 'old')).toContain('last heard from 12 min ago');
    expect(row(container, 'old')).toContain('no heartbeat for 5 min');
    expect(row(container, 'idle')).toContain('No task was running on it');
  });

  it('says a host that has never beaten is never seen, not silent', async () => {
    const container = await mount(view([host('new', { state: 'never_seen', lastSeenAt: null })]));
    expect(row(container, 'new')).toContain('never seen');
    expect(container.textContent).not.toMatch(/silent/i);
    expect(row(container, 'new')).not.toContain('seen 8 s ago');
  });

  it('says no host has registered, and points to openadlc doctor', async () => {
    const container = await mount(view([]));
    expect(container.textContent).toContain('No host has registered yet');
    expect(container.querySelector('code')?.textContent).toBe('openadlc doctor');
  });

  it('counts the queued tasks no host has claimed yet', async () => {
    const container = await mount(view([host('mac')], 2));
    expect(container.textContent).toContain('2 tasks waiting to be claimed by a host');
  });

  it('says memory in GB, with one decimal under ten', async () => {
    const container = await mount(view([host('small', { memoryBytes: 8053063680 })]));
    expect(row(container, 'small')).toContain('7.5 GB');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));

import { query } from '../client.js';
import { dismissFixed, listHealth, saveHealth, type HealthRow } from './health.js';

beforeEach(() => {
  vi.mocked(query).mockReset();
});

const ROW: HealthRow = {
  id: 'signing-key:bot-builder',
  checkId: 'signing-key',
  subject: 'bot-builder',
  state: 'failing',
  severity: 'blocking',
  title: 'fleetadlc-atlas-janedoe’s signing key is not on its GitHub account',
  detail: 'Reconnect fleetadlc-atlas-janedoe so GitHub learns its signing key.',
  action: { label: 'Reconnect fleetadlc-atlas-janedoe', href: '/settings#github-accounts' },
  facts: { botId: 'bot-builder', requiresSignatures: { 'fleetadlc-testbed': true } },
  waitingFor: ['app-permissions:git_signing_ssh_public_keys'],
  failingSince: '2026-09-25T11:00:00.000Z',
  checkedAt: '2026-09-25T12:00:00.000Z',
  notifiedAt: null,
  fixedAt: null,
  fixedTitle: null,
  fixedDismissedAt: null,
};

describe('a health check’s row', () => {
  it('is written whole, its action and facts as JSON the dispatcher can read back', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await saveHealth(ROW);

    const [sql, params] = vi.mocked(query).mock.calls[0]!;
    expect(sql).toMatch(/insert into health_checks .* on conflict \(id\) do update/s);
    expect(params).toEqual([
      'signing-key:bot-builder',
      'signing-key',
      'bot-builder',
      'failing',
      'blocking',
      ROW.title,
      ROW.detail,
      JSON.stringify(ROW.action),
      JSON.stringify(ROW.facts),
      ['app-permissions:git_signing_ssh_public_keys'],
      '2026-09-25T11:00:00.000Z',
      '2026-09-25T12:00:00.000Z',
      null,
      null,
      null,
      null,
    ]);
  });

  it('reads back as it was written', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      {
        id: ROW.id,
        check_id: 'signing-key',
        subject: 'bot-builder',
        state: 'failing',
        severity: 'blocking',
        title: ROW.title,
        detail: ROW.detail,
        action: ROW.action,
        facts: ROW.facts,
        waiting_for: ROW.waitingFor,
        failing_since: new Date(ROW.failingSince!),
        checked_at: new Date(ROW.checkedAt),
        notified_at: null,
        fixed_at: null,
        fixed_title: null,
        fixed_dismissed_at: null,
      },
    ]);
    expect(await listHealth()).toEqual([ROW]);
  });

  it('stops saying it was fixed once dismissed, and only when it had something to say', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ id: 'webhook' }]);
    expect(await dismissFixed('webhook')).toBe(true);
    expect(vi.mocked(query).mock.calls[0]![0]).toMatch(/fixed_at is not null and fixed_dismissed_at is null/);
    vi.mocked(query).mockResolvedValueOnce([]);
    expect(await dismissFixed('hostd')).toBe(false);
  });
});

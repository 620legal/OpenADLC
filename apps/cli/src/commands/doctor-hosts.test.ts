import { describe, expect, it } from 'vitest';
import { hostLine } from './doctor.js';

const NOW = Date.parse('2026-09-25T06:00:00Z');

describe('what the doctor says about a host', () => {
  it('fails a host some bot is on when it has stopped reporting', () => {
    expect(hostLine({ name: 'mac', driver: 'docker', lastSeenAt: '2026-09-25T05:50:00Z' }, true, NOW).kind).toBe('fail');
  });

  it('only notes an old record no bot is on — the seed once made one named local', () => {
    const line = hostLine({ name: 'local', driver: 'docker', lastSeenAt: '2026-09-25T05:00:00Z' }, false, NOW);
    expect(line).toEqual({ kind: 'note', text: 'host local has no bots on it and has not reported recently; it is an old record' });
  });

  it('says a host is reporting when it reported within the minute', () => {
    expect(hostLine({ name: 'mac', driver: 'docker', lastSeenAt: '2026-09-25T05:59:30Z' }, true, NOW).kind).toBe('ok');
  });
});

import { describe, expect, it } from 'vitest';
import { CONTAINER_HOST_ALIAS, reachableFromTask } from './reachable.js';

describe('the address a task is given for a host service', () => {
  it('rewrites loopback under the docker driver', () => {
    // The bug this exists for: the skill runner posts every state report, cost
    // check and gate to FLEETADLC_BRIDGE_URL, and inside a container on a per-bot
    // network `127.0.0.1` is the container itself.
    expect(reachableFromTask('http://127.0.0.1:47311', 'docker')).toBe(`http://${CONTAINER_HOST_ALIAS}:47311`);
    expect(reachableFromTask('http://localhost:47312', 'docker')).toBe(`http://${CONTAINER_HOST_ALIAS}:47312`);
  });

  it('leaves it alone under the local driver, where loopback is right', () => {
    expect(reachableFromTask('http://127.0.0.1:47311', 'local')).toBe('http://127.0.0.1:47311');
  });

  it('leaves a real hostname alone, because the operator meant it', () => {
    // An install whose bridge is behind a name already reachable from the
    // container must not have it replaced by the docker alias.
    expect(reachableFromTask('https://fleetadlc.internal.example', 'docker')).toBe('https://fleetadlc.internal.example');
    expect(reachableFromTask('http://bridge:47311', 'docker')).toBe('http://bridge:47311');
  });

  it('keeps the port and the scheme', () => {
    expect(reachableFromTask('https://127.0.0.1:8443', 'docker')).toBe(`https://${CONTAINER_HOST_ALIAS}:8443`);
  });

  it('does not add a trailing slash, because paths are appended to it', () => {
    // `${bridgeUrl}/internal/tasks/...` would otherwise produce a double slash.
    expect(reachableFromTask('http://127.0.0.1:47311', 'docker')).not.toMatch(/\/$/);
  });

  it('handles the wildcard and IPv6 loopback a config might carry', () => {
    expect(reachableFromTask('http://0.0.0.0:47312', 'docker')).toBe(`http://${CONTAINER_HOST_ALIAS}:47312`);
    expect(reachableFromTask('http://[::1]:47312', 'docker')).toBe(`http://${CONTAINER_HOST_ALIAS}:47312`);
  });

  it('returns something unparseable unchanged rather than guessing', () => {
    expect(reachableFromTask('not a url', 'docker')).toBe('not a url');
  });
});

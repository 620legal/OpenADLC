import { describe, expect, it } from 'vitest';
import { egressHostProblem, egressListAllows, normalEgressHost, parseEgressHosts, withoutCoveredHosts } from './egress.js';

/**
 * The names an admin allows in Settings go onto the egress proxy's list,
 * matched as the module's own are: a name and everything under it.
 */
describe('a name an admin may allow', () => {
  it('is a bare host name of two labels or more', () => {
    expect(egressHostProblem('web-1234-uc.a.run.app')).toBeNull();
    expect(egressHostProblem('testing.acme.example')).toBeNull();
  });

  it('is not a URL, an address, a single label or anything that could write a line of its own', () => {
    expect(egressHostProblem('https://testing.acme.example')).toContain('no scheme, port or path');
    expect(egressHostProblem('testing.acme.example:8443')).toContain('no scheme, port or path');
    expect(egressHostProblem('10.0.0.5')).toContain('an address');
    expect(egressHostProblem('app')).toContain('single label');
    expect(egressHostProblem('acme.example\n.evil.example')).toContain('no scheme, port or path');
    expect(egressHostProblem('acme_example.com')).toContain('not a host name');
    expect(egressHostProblem('')).toContain('give a host name');
  });

  it('is kept as typed into a field: lower case, without a scheme, a path or a leading dot', () => {
    expect(normalEgressHost('  https://Web-1234-UC.a.run.app/login?next=1 ')).toBe('web-1234-uc.a.run.app');
    expect(normalEgressHost('.acme.example')).toBe('acme.example');
  });
});

describe('the list', () => {
  it('lets a name through when it or a parent of it is listed, as the proxy’s leading dot does', () => {
    expect(egressListAllows(['acme.example'], 'testing.acme.example')).toBe('acme.example');
    expect(egressListAllows(['acme.example'], 'acme.example')).toBe('acme.example');
    expect(egressListAllows(['acme.example'], 'notacme.example')).toBeNull();
    expect(egressListAllows(['testing.acme.example'], 'acme.example')).toBeNull();
  });

  it('reads as it is stored, and is written without a name another covers', () => {
    expect(parseEgressHosts(' a.example, B.example,,a.example ')).toEqual(['a.example', 'b.example']);
    expect(parseEgressHosts(null)).toEqual([]);
    expect(withoutCoveredHosts(['testing.acme.example', 'acme.example', 'other.example'])).toEqual(['acme.example', 'other.example']);
  });
});

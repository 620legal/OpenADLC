import { describe, expect, it } from 'vitest';
import { compareRepoVersionsIgnoringLabel, compareRepoVersions, parseRepoVersion, repoVersionFrom, repoVersionFromTag, repoVersionGate, type RepoVersion } from './release-version.js';

const v = (text: string): RepoVersion => {
  const read = repoVersionFrom(text);
  if (!read.ok) throw new Error(read.reason);
  return read.version;
};

describe('the release version rule', () => {
  it.each(['1', '1.4.0', '156.0.8078.79', '1.2.3.4-x.0', '156.0.8078.79-abc.29'])('accepts %s', (text) => {
    expect(repoVersionFrom(text).ok).toBe(true);
  });

  it.each([
    ['five parts', '1.2.3.4.5'],
    ['a label with no .N', '1.4.0-rc'],
    ['an uppercase label', '1.4.0-RC.1'],
    ['a suffix with two numbers', '1.4.0-x.1.2'],
    ['a leading zero', '01.2'],
    ['a build suffix', '1.4.0+b5'],
    ['a v in the file', 'v1.4.0'],
    ['a part over MAX_SAFE_INTEGER', `1.${'9'.repeat(17)}`],
    ['a 33-character label', `1.0-${'a'.repeat(33)}.1`],
    ['more than 64 characters', `1.0-${'a'.repeat(32)}.${'1'.repeat(30)}`],
  ])('refuses %s, naming the forms', (_name, text) => {
    const read = repoVersionFrom(text, 'VERSION');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toMatch(/is not a release version.*<1 to 4 numbers>-<lowercase label>\.<number>.* in VERSION/);
  });

  it('reads a plain file, JSON with a dotted key, and an xcconfig line', () => {
    expect(parseRepoVersion('1.4.0\n', 'VERSION', null)).toMatchObject({ ok: true, version: { text: '1.4.0' } });
    expect(parseRepoVersion('{"version":"2.0"}', 'package.json', null)).toMatchObject({ ok: true, version: { text: '2.0' } });
    expect(parseRepoVersion('{"app":{"release":"2.1-x.3"}}', 'meta.json', 'app.release')).toMatchObject({ ok: true, version: { text: '2.1-x.3', label: 'x', n: 3 } });
    expect(parseRepoVersion('// header\nMARKETING_VERSION = 156.0.8078.79-abc.29\n', 'Config/Version.xcconfig', 'MARKETING_VERSION')).toMatchObject({
      ok: true,
      version: { text: '156.0.8078.79-abc.29', parts: [156, 0, 8078, 79], label: 'abc', n: 29 },
    });
    expect(parseRepoVersion('VERSION: "3.1"', 'release.yml', 'VERSION')).toMatchObject({ ok: true, version: { text: '3.1' } });
    expect(parseRepoVersion('OTHER = 1', 'a.xcconfig', 'MARKETING_VERSION')).toMatchObject({ ok: false });
    expect(parseRepoVersion('{"name":"x"}', 'package.json', null)).toMatchObject({ ok: false });
    expect(parseRepoVersion('not json', 'package.json', null)).toMatchObject({ ok: false });
  });

  it('orders by the numbers, then N, with a bare version at N = 0, and never across labels', () => {
    expect(compareRepoVersions(v('1.2.3.4-x.10'), v('1.2.3.4-x.9'))).toBe(1);
    expect(compareRepoVersions(v('1.2.3.4-x.10'), v('1.2.3.4'))).toBe(1);
    expect(compareRepoVersions(v('1.2.3.5'), v('1.2.3.4-x.99'))).toBe(1);
    expect(compareRepoVersions(v('1.2.3.4-x.10'), v('1.2.3.4-x.10'))).toBe(0);
    expect(compareRepoVersions(v('1.2'), v('1.2.0'))).toBe(0);
    expect(compareRepoVersions(v('1.2.3.4'), v('1.2.3.4-x.0'))).toBe(0);
    expect(compareRepoVersions(v('1.2.3.4-y.11'), v('1.2.3.4-x.10'))).toBeNull();
    expect(compareRepoVersionsIgnoringLabel(v('1.2.3.4-y.11'), v('1.2.3.4-x.10'))).toBe(1);
    expect(compareRepoVersions(v('1.4'), v('1.10'))).toBe(-1);
  });

  it('gates the next version on the last release', () => {
    expect(repoVersionGate(v('1.2.3.4-x.10'), v('1.2.3.4-x.9'), 'VERSION')).toBeNull();
    expect(repoVersionGate(v('1.2.3.4-x.10'), v('1.2.3.4'), 'VERSION')).toBeNull();
    expect(repoVersionGate(v('1.2.3.5'), v('1.2.3.4-x.99'), 'VERSION')).toBeNull();
    expect(repoVersionGate(v('1.0'), null, 'VERSION')).toBeNull();
    expect(repoVersionGate(v('1.2.3.4-x.10'), v('1.2.3.4-x.10'), 'VERSION')).toBe('1.2.3.4-x.10 is not above the last release, 1.2.3.4-x.10: raise it in VERSION');
    expect(repoVersionGate(v('1.2.3.4-y.11'), v('1.2.3.4-x.10'), 'VERSION')).toBe('1.2.3.4-y.11 has the label y, and the last release, 1.2.3.4-x.10, has x: use x in VERSION');
  });

  it('reads a tag with one leading v taken off, and skips one that is not a version', () => {
    expect(repoVersionFromTag('v156.0.8078.79-abc.29')).toMatchObject({ text: '156.0.8078.79-abc.29', label: 'abc', n: 29 });
    expect(repoVersionFromTag('1.4.0')).toMatchObject({ text: '1.4.0' });
    expect(repoVersionFromTag('vv1.4.0')).toBeNull();
    expect(repoVersionFromTag('release-2020')).toBeNull();
  });
});

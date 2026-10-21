import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveRefused, readArchive, unpackArchive } from './release-archive.js';

/**
 * What comes out of a release's archive is decided entry by entry: only the
 * built output and the manifest, only directories and files, written new
 * under the tree and never through a link. These build archives by hand, so
 * each bad entry is exactly the one under test, and one with the system's own
 * tar, so what release.yml's GNU tar writes is read the same way.
 */
const MANIFEST = JSON.stringify({ format: 1, tag: 'v0.2.0', commit: 'a'.repeat(40), tree: 'b'.repeat(40) });

interface Spec {
  path: string;
  type?: '0' | '1' | '2' | '5' | '3';
  data?: string;
  mode?: number;
  link?: string;
}

function header(path: string, type: string, size: number, mode: number, link = ''): Buffer {
  const block = Buffer.alloc(512);
  block.write(path, 0, 100, 'utf8');
  block.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii');
  block.write('0000000\0', 108, 'ascii');
  block.write('0000000\0', 116, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  block.write('00000000000\0', 136, 'ascii');
  block.write('        ', 148, 'ascii');
  block.write(type, 156, 'ascii');
  block.write(link, 157, 100, 'utf8');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

function padded(data: Buffer): Buffer {
  return Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

/** A gzip-compressed tar of these entries, a pax header before any path past 100 bytes. */
function tarOf(specs: Spec[]): Buffer {
  const parts: Buffer[] = [];
  for (const spec of specs) {
    const type = spec.type ?? '0';
    const data = Buffer.from(spec.data ?? '', 'utf8');
    if (Buffer.byteLength(spec.path) > 99) {
      const body = (() => {
        const record = ` path=${spec.path}\n`;
        let length = record.length + 2;
        while (`${length}${record}`.length !== length) length += 1;
        return Buffer.from(`${length}${record}`, 'utf8');
      })();
      parts.push(header('PaxHeader', 'x', body.length, 0o644), padded(body));
    }
    parts.push(header(spec.path.slice(0, 99), type, type === '0' ? data.length : 0, spec.mode ?? (type === '5' ? 0o755 : 0o644), spec.link));
    if (type === '0') parts.push(padded(data));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

const made: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'release-archive-'));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function archiveFile(specs: Spec[]): string {
  const file = join(scratch(), 'openadlc-v0.2.0.tar.gz');
  writeFileSync(file, tarOf(specs));
  return file;
}

const GOOD: Spec[] = [
  { path: 'openadlc-release.json', data: MANIFEST },
  { path: 'apps/bridge/dist', type: '5' },
  { path: 'apps/bridge/dist/main.js', data: 'console.log("bridge")' },
  { path: 'apps/cli/dist/bin.js', data: '#!/usr/bin/env node', mode: 0o755 },
  { path: `apps/console/.next/server/app/${'deep/'.repeat(20)}page.js`, data: 'page' },
];

describe('reading a release’s archive', () => {
  it('reads the manifest and the built output, long paths included', () => {
    const { manifest, entries } = readArchive(archiveFile(GOOD));
    expect(manifest).toEqual(JSON.parse(MANIFEST));
    expect(entries.map((entry) => entry.path)).toEqual([
      'apps/bridge/dist',
      'apps/bridge/dist/main.js',
      'apps/cli/dist/bin.js',
      `apps/console/.next/server/app/${'deep/'.repeat(20)}page.js`,
    ]);
    expect(entries.find((entry) => entry.path === 'apps/cli/dist/bin.js')?.executable).toBe(true);
  });

  it.each([
    ['a symbolic link', { path: 'apps/bridge/dist/x.js', type: '2', link: '/etc/passwd' } as Spec, /symbolic link/],
    ['a hard link', { path: 'apps/bridge/dist/y.js', type: '1', link: 'apps/bridge/dist/main.js' } as Spec, /hard link/],
    ['a device', { path: 'apps/bridge/dist/dev', type: '3' } as Spec, /type "3"/],
    ['a path out of the tree', { path: 'apps/bridge/dist/../../../../etc/cron.d/x', data: 'x' } as Spec, /not part of the built output/],
    ['an absolute path', { path: '/etc/cron.d/x', data: 'x' } as Spec, /not part of the built output/],
    ['source rather than output', { path: 'apps/bridge/src/main.ts', data: 'x' } as Spec, /not part of the built output/],
    ['a skill', { path: 'crew/skills/implement/tools.yaml', data: 'x' } as Spec, /not part of the built output/],
    ['the build cache', { path: 'apps/console/.next/cache/x', data: 'x' } as Spec, /not part of the built output/],
    ['a file twice', { path: 'apps/bridge/dist/main.js', data: 'again' } as Spec, /twice/],
  ])('refuses the whole archive for %s', (_what, bad, reason) => {
    expect(() => readArchive(archiveFile([...GOOD, bad]))).toThrow(reason);
  });

  it('refuses one with no manifest, or with a manifest release.yml did not write', () => {
    expect(() => readArchive(archiveFile(GOOD.slice(1)))).toThrow(/no openadlc-release.json/);
    expect(() => readArchive(archiveFile([{ path: 'openadlc-release.json', data: '{"format":1}' }, ...GOOD.slice(1)]))).toThrow(/not the manifest/);
  });

  it('refuses what is not a whole gzip-compressed tar', () => {
    const file = join(scratch(), 'x.tar.gz');
    writeFileSync(file, 'not gzip');
    expect(() => readArchive(file)).toThrow(ArchiveRefused);
    // Cut short: the manifest's header and data, and no end marker.
    writeFileSync(file, gzipSync(gunzipSync(tarOf(GOOD)).subarray(0, 1024)));
    expect(() => readArchive(file)).toThrow(/ends before its end marker/);
  });

  it('reads what the system’s tar writes in pax format, as release.yml’s does', () => {
    const tree = scratch();
    mkdirSync(join(tree, 'apps/bridge/dist'), { recursive: true });
    mkdirSync(join(tree, `apps/console/.next/server/${'nested-directory/'.repeat(8)}`), { recursive: true });
    writeFileSync(join(tree, 'openadlc-release.json'), MANIFEST);
    writeFileSync(join(tree, 'apps/bridge/dist/main.js'), 'bridge');
    writeFileSync(join(tree, `apps/console/.next/server/${'nested-directory/'.repeat(8)}page.js`), 'page');
    const file = join(scratch(), 'system.tar.gz');
    execFileSync('tar', ['--format=pax', '-czf', file, 'openadlc-release.json', 'apps/bridge/dist', 'apps/console/.next'], {
      cwd: tree,
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const { entries } = readArchive(file);
    expect(entries.filter((entry) => entry.type === 'file').map((entry) => entry.path).sort()).toEqual([
      'apps/bridge/dist/main.js',
      `apps/console/.next/server/${'nested-directory/'.repeat(8)}page.js`,
    ]);
  });
});

describe('unpacking it', () => {
  it('writes each file new under the tree, with its execute bit', () => {
    const tree = scratch();
    mkdirSync(join(tree, 'apps'), { recursive: true });
    const { entries } = readArchive(archiveFile(GOOD));
    expect(unpackArchive(entries, tree)).toBe(3);
    expect(readFileSync(join(tree, 'apps/bridge/dist/main.js'), 'utf8')).toBe('console.log("bridge")');
    expect(statSync(join(tree, 'apps/cli/dist/bin.js')).mode & 0o111).not.toBe(0);
    expect(existsSync(join(tree, 'openadlc-release.json'))).toBe(false);
  });

  it('never writes through a link the tree already has, or over a file', () => {
    const tree = scratch();
    const elsewhere = scratch();
    mkdirSync(join(tree, 'apps/bridge'), { recursive: true });
    symlinkSync(elsewhere, join(tree, 'apps/bridge/dist'));
    const { entries } = readArchive(archiveFile(GOOD));
    expect(() => unpackArchive(entries, tree)).toThrow(/in the way/);
    expect(existsSync(join(elsewhere, 'main.js'))).toBe(false);

    const second = scratch();
    mkdirSync(join(second, 'apps/bridge/dist'), { recursive: true });
    writeFileSync(join(second, 'apps/bridge/dist/main.js'), 'already here');
    expect(() => unpackArchive(entries, second)).toThrow(/could not be written new/);
    expect(readFileSync(join(second, 'apps/bridge/dist/main.js'), 'utf8')).toBe('already here');
  });
});

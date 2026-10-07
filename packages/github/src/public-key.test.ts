import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateSigningKey, publicKeyOf, sameSigningKey } from './signing.js';

const hasSshKeygen = (() => {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'pipe' });
    return true;
  } catch (error) {
    // ssh-keygen exits non-zero for -?; only a missing binary is ENOENT.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
})();

// The tests may write keys to a temp directory to run the real ssh-keygen as an
// oracle; signing.ts itself never does.
const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-key-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const body = (key: string) => key.trim().split(/\s+/).slice(0, 2).join(' ');

describe('a stored signing key’s public half', () => {
  it('is the public key the pair was made with', () => {
    const pair = generateSigningKey('builder');
    expect(sameSigningKey(publicKeyOf(pair.privateKey), pair.publicKey)).toBe(true);
  });

  it('matches regardless of the comment, and not a different key', () => {
    expect(sameSigningKey('ssh-ed25519 AAAA one', 'ssh-ed25519 AAAA two')).toBe(true);
    expect(sameSigningKey('ssh-ed25519 AAAA', 'ssh-ed25519 BBBB')).toBe(false);
    expect(sameSigningKey('', '')).toBe(false);
  });

  it.skipIf(!hasSshKeygen)('is what ssh-keygen -y prints for a key ssh-keygen made', () => {
    const path = join(scratch(), 'id_ed25519');
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-C', 'someone', '-N', '', '-q', '-f', path], { stdio: 'pipe' });
    const expected = execFileSync('ssh-keygen', ['-y', '-f', path], { encoding: 'utf8' });
    const stored = readFileSync(path, 'utf8');
    expect(publicKeyOf(stored)).toBe(body(expected));
  });

  it('refuses text that is not an unencrypted openssh-key-v1 key', () => {
    const pem = generateKeyPairSync('rsa', { modulusLength: 1024 })
      .privateKey.export({ format: 'pem', type: 'pkcs1' })
      .toString();
    expect(() => publicKeyOf(pem)).toThrow(/not an OpenSSH private key/);
    expect(() => publicKeyOf('hello')).toThrow(/not an OpenSSH private key/);

    // An encrypted key: the same layout with "aes256-ctr" as its cipher.
    const pair = generateSigningKey('builder');
    const lines = pair.privateKey.trim().split('\n');
    const data = Buffer.from(lines.slice(1, -1).join(''), 'base64');
    const encrypted = Buffer.concat([
      data.subarray(0, 15),
      Buffer.from([0, 0, 0, 10]),
      Buffer.from('aes256-ctr'),
      data.subarray(15 + 4 + 4),
    ]).toString('base64');
    const armoured = `${lines[0]}\n${encrypted}\n${lines[lines.length - 1]}\n`;
    expect(() => publicKeyOf(armoured)).toThrow(/encrypted \(aes256-ctr\)/);
  });
});

describe('a new signing key', () => {
  it('is an OpenSSH ed25519 key named for the bot', () => {
    const pair = generateSigningKey('builder');
    expect(pair.privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n')).toBe(true);
    expect(pair.privateKey.endsWith('-----END OPENSSH PRIVATE KEY-----\n')).toBe(true);
    expect(pair.publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/=]+ fleetadlc-builder$/);
    for (const line of pair.privateKey.trim().split('\n')) expect(line.length).toBeLessThanOrEqual(70);
  });

  it('is two different keys for two calls', () => {
    expect(generateSigningKey('builder').publicKey).not.toBe(generateSigningKey('builder').publicKey);
  });

  it.skipIf(!hasSshKeygen)('is a key ssh-keygen accepts, with the same public half', () => {
    const pair = generateSigningKey('builder');
    const path = join(scratch(), 'key');
    writeFileSync(path, pair.privateKey, { mode: 0o600 });
    const printed = execFileSync('ssh-keygen', ['-y', '-f', path], { encoding: 'utf8' });
    expect(sameSigningKey(printed, pair.publicKey)).toBe(true);
  });

  it('is made and read without starting a process', () => {
    const path = process.env.PATH;
    process.env.PATH = '';
    try {
      const pair = generateSigningKey('builder');
      expect(sameSigningKey(publicKeyOf(pair.privateKey), pair.publicKey)).toBe(true);
    } finally {
      process.env.PATH = path;
    }
  });
});

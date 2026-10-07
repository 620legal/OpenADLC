import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS, checkAttachment, itemRoomFor, safeFileName } from './attachments.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe('what may be attached', () => {
  it('takes the type from the bytes, not the name', () => {
    expect(checkAttachment({ name: 'mockup.txt', bytes: PNG })).toMatchObject({ ok: true, mediaType: 'image/png' });
    expect(checkAttachment({ name: 'spec.pdf', bytes: bytes('%PDF-1.7\n…') })).toMatchObject({ ok: true, mediaType: 'application/pdf' });
    expect(checkAttachment({ name: 'notes.md', bytes: bytes('# Notes\n\nThe header is blue.') })).toMatchObject({ ok: true, mediaType: 'text/markdown' });
    expect(checkAttachment({ name: 'rows.csv', bytes: bytes('a,b\n1,2\n') })).toMatchObject({ ok: true, mediaType: 'text/csv' });
  });

  it('refuses SVG and HTML, however they are named, since either can carry script', () => {
    expect(checkAttachment({ name: 'logo.svg', bytes: bytes('<svg xmlns="http://www.w3.org/2000/svg"/>') })).toMatchObject({ ok: false });
    const disguised = checkAttachment({ name: 'notes.txt', bytes: bytes('<!DOCTYPE html><html><script>alert(1)</script></html>') });
    expect(disguised).toMatchObject({ ok: false, reason: expect.stringMatching(/HTML or SVG/) });
  });

  it('refuses JavaScript, and says to send it as text rather than a picture of it', () => {
    const script = checkAttachment({ name: 'app.js', bytes: bytes('export const a = 1;\n') });
    expect(script).toMatchObject({ ok: false, reason: 'app.js is JavaScript, which a browser could run; paste the code or attach it as a .txt file instead' });
    expect(checkAttachment({ name: 'app.txt', bytes: bytes('export const a = 1;\n') })).toMatchObject({ ok: true });
    expect(checkAttachment({ name: 'logo.svg', bytes: bytes('<svg/>') })).toMatchObject({ ok: false, reason: expect.stringMatching(/PNG or a PDF/) });
  });

  it('refuses a text file with a credential in it, and says why', () => {
    const leaked = checkAttachment({ name: 'env.txt', bytes: bytes(`GITHUB_TOKEN=ghp_${'a'.repeat(36)}\n`) });
    expect(leaked).toMatchObject({ ok: false, reason: expect.stringMatching(/env\.txt contains what looks like a credential/) });
  });

  it('refuses a model provider key or a private key, naming which it found', () => {
    const anthropic = checkAttachment({ name: 'env.txt', bytes: bytes(`ANTHROPIC_API_KEY=sk-ant-api03-${'a'.repeat(40)}\n`) });
    expect(anthropic).toMatchObject({ ok: false, reason: expect.stringMatching(/\(an Anthropic key\)/) });
    const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn', '-----END RSA PRIVATE KEY-----'].join('\n');
    expect(checkAttachment({ name: 'id_rsa.txt', bytes: bytes(pem) })).toMatchObject({ ok: false, reason: expect.stringMatching(/\(a private key\)/) });
  });

  it('refuses what is too large or not a type it takes, naming the file', () => {
    const big = new Uint8Array(ATTACHMENT_LIMITS.fileBytes + 1);
    big.set(PNG);
    expect(checkAttachment({ name: 'huge.png', bytes: big })).toMatchObject({ ok: false, reason: expect.stringMatching(/^huge\.png is 10\.1 MB; a file can be 10 MB at most/) });
    expect(checkAttachment({ name: 'app.exe', bytes: new Uint8Array([0x4d, 0x5a, 0, 1, 2]) })).toMatchObject({ ok: false, reason: expect.stringMatching(/app\.exe is not a type/) });
  });

  it('holds a work item to twenty files and 25 MB together', () => {
    expect(itemRoomFor({ count: 19, bytes: 0 }, { count: 1, bytes: 10 })).toBeNull();
    expect(itemRoomFor({ count: 19, bytes: 0 }, { count: 2, bytes: 10 })).toMatch(/20 files/);
    expect(itemRoomFor({ count: 1, bytes: 20 * 1024 * 1024 }, { count: 1, bytes: 6 * 1024 * 1024 })).toMatch(/25 MB/);
  });

  it('names a file so it cannot leave the folder it is written to', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('Screen Shot 2026-09-30 at 10.12.png')).toBe('Screen-Shot-2026-09-30-at-10.12.png');
    expect(safeFileName('.hidden')).toBe('hidden');
    expect(safeFileName('', 'image/png')).toBe('attachment.png');
  });
});

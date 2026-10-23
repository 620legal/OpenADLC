import { describe, expect, it } from 'vitest';
import { checkConsoleLogo, checkConsoleName, decodeLogo, logoMediaType } from './brand.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00');
const SVG = Buffer.from('<?xml version="1.0"?>\n<!-- Acme -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>');

const dataUrl = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString('base64')}`;
const ALLOWED = /PNG, JPG, SVG or WebP image of at most 256 KB/;

describe('the console name', () => {
  it('is at most 40 characters, counted as they are read, and says the limit of a longer one', () => {
    expect(checkConsoleName('a'.repeat(40))).toEqual({ ok: true, value: 'a'.repeat(40) });
    expect(checkConsoleName('é'.repeat(40))).toMatchObject({ ok: true });
    const longer = checkConsoleName('a'.repeat(41));
    expect(longer).toMatchObject({ ok: false });
    expect(!longer.ok && longer.error).toContain('at most 40 characters; this one is 41');
  });

  it('is stored trimmed, and an empty one clears it', () => {
    expect(checkConsoleName('  Acme Legal  ')).toEqual({ ok: true, value: 'Acme Legal' });
    expect(checkConsoleName('')).toEqual({ ok: true, value: '' });
  });

  it('refuses one that is only whitespace, or holds a line break or a control character', () => {
    const blank = checkConsoleName('   ');
    expect(!blank.ok && blank.error).toContain('remove it to go back to OpenADLC');
    for (const name of ['Acme\nLegal', 'Acme\u0007']) expect(checkConsoleName(name), JSON.stringify(name)).toMatchObject({ ok: false });
  });
});

describe('the console logo', () => {
  it('takes a PNG, JPEG, WebP and SVG, stored as the type its bytes are', () => {
    for (const [type, bytes] of [['image/png', PNG], ['image/jpeg', JPEG], ['image/webp', WEBP], ['image/svg+xml', SVG]] as const) {
      expect(checkConsoleLogo(dataUrl(type, bytes)), type).toEqual({ ok: true, value: dataUrl(type, bytes) });
    }
    expect(checkConsoleLogo(dataUrl('IMAGE/PNG', PNG))).toEqual({ ok: true, value: dataUrl('image/png', PNG) });
  });

  it('takes 256 KB and an empty value, which clears it', () => {
    const largest = Buffer.concat([PNG, Buffer.alloc(256 * 1024 - PNG.length)]);
    expect(checkConsoleLogo(dataUrl('image/png', largest))).toMatchObject({ ok: true });
    expect(checkConsoleLogo('')).toEqual({ ok: true, value: '' });
  });

  it('refuses everything else, and says what is allowed and what was wrong', () => {
    const cases: [string, string, RegExp][] = [
      ['a GIF', dataUrl('image/gif', GIF), /this one is image\/gif/],
      ['one byte over 256 KB', dataUrl('image/png', Buffer.concat([PNG, Buffer.alloc(256 * 1024 + 1 - PNG.length)])), /this one is 257 KB/],
      ['empty bytes', 'data:image/png;base64,', /empty/],
      ['text declared a PNG', dataUrl('image/png', Buffer.from('just some text')), /says PNG but is not an image/],
      ['a PNG declared WebP', dataUrl('image/webp', PNG), /says WebP but is PNG/],
      ['a PNG declared SVG', dataUrl('image/svg+xml', PNG), /says SVG but is PNG/],
      ['an SVG with a DOCTYPE', dataUrl('image/svg+xml', Buffer.from('<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg>&a;</svg>')), /DOCTYPE or an entity/],
      ['text declared SVG', dataUrl('image/svg+xml', Buffer.from('<html><script>alert(1)</script></html>')), /not an <svg> drawing/],
      ['not a data URL', 'https://example.test/logo.png', /not an image file/],
      ['not base64', 'data:image/png,%89PNG', /not base64-encoded/],
      ['broken base64', 'data:image/png;base64,iVBO*w0K', /not base64-encoded/],
    ];
    for (const [name, value, what] of cases) {
      const checked = checkConsoleLogo(value);
      expect(checked.ok, name).toBe(false);
      expect(!checked.ok && checked.error, name).toMatch(ALLOWED);
      expect(!checked.ok && checked.error, name).toMatch(what);
    }
  });

  it('is served as the type and bytes it was stored as', () => {
    expect(decodeLogo(dataUrl('image/svg+xml', SVG))).toEqual({ mediaType: 'image/svg+xml', bytes: SVG });
    expect(decodeLogo('data:text/html;base64,PGI+')).toBeNull();
    expect(logoMediaType(dataUrl('image/webp', WEBP).slice(0, 40))).toBe('image/webp');
    expect(logoMediaType('data:text/html;base64,PGI+')).toBeNull();
  });
});

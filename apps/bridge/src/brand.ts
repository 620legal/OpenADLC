import { asText, sniffBinary } from '@openadlc/shared';

/**
 * The console's own name and logo (`consoleName`, `consoleLogo`), checked
 * before `PATCH /v1/install` stores them. Every person using the console sees
 * both, so neither may be anything a browser would run: the name is drawn as
 * text, and the logo is only ever drawn through an `<img>` and served
 * sandboxed (`GET /v1/brand/logo`). What this refuses is what would not draw,
 * or would hang the tab that draws it.
 *
 * Not the install name (`installName`), which heads OpenADLC's posts on GitHub.
 */

export const CONSOLE_NAME_MAX = 40;
export const CONSOLE_LOGO_MAX_BYTES = 256 * 1024;

export type Checked = { ok: true; value: string } | { ok: false; error: string };

/** A name as stored: trimmed, or `''` to clear it and go back to "OpenADLC". */
export function checkConsoleName(value: string): Checked {
  if (value === '') return { ok: true, value: '' };
  const name = value.trim();
  if (name === '') return { ok: false, error: 'type a name, or remove it to go back to OpenADLC' };
  // A line break drew the header on two lines, and a control character as a box.
  if (/\p{Cc}/u.test(name)) return { ok: false, error: 'a console name is one line of text, with no line breaks or control characters' };
  // Code points, so a name with an accent or an emoji is counted as it is read.
  const length = [...name].length;
  if (length > CONSOLE_NAME_MAX) return { ok: false, error: `a console name is at most ${CONSOLE_NAME_MAX} characters; this one is ${length}` };
  return { ok: true, value: name };
}

const ALLOWED = 'the logo must be a PNG, JPG, SVG or WebP image of at most 256 KB';

const NAMES: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPG',
  'image/svg+xml': 'SVG',
  'image/webp': 'WebP',
};

/**
 * A logo as stored: a `data:<type>;base64,<bytes>` whose bytes are the type it
 * says, of 1 to 256 KB, with the type the bytes were found to be; or `''` to
 * clear it. A text file renamed `.png`, or a PNG sent as WebP, is refused: the
 * type is the one the logo is served as.
 */
export function checkConsoleLogo(value: string): Checked {
  if (value === '') return { ok: true, value: '' };
  const parts = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(value);
  if (!parts) return refused('this is not an image file');
  const declared = (parts[1] ?? '').toLowerCase();
  // GIF too, although the attachments know it: the logo's list leaves it out.
  if (!NAMES[declared]) return refused(declared ? `this one is ${declared}` : 'this one says no type');
  if (!parts[2]) return refused('this one is not base64-encoded');
  const encoded = parts[3] ?? '';
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return refused('this one is not base64-encoded');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0) return refused('this one is empty');
  if (bytes.length > CONSOLE_LOGO_MAX_BYTES) return refused(`this one is ${Math.ceil(bytes.length / 1024)} KB`);

  const found = sniffBinary(bytes);
  if (declared === 'image/svg+xml') {
    if (found !== null) return refused(`this one says SVG but is ${NAMES[found] ?? found}`);
    const problem = svgProblem(bytes);
    if (problem) return refused(problem);
  } else if (found !== declared) {
    return refused(`this one says ${NAMES[declared]} but ${found && NAMES[found] ? `is ${NAMES[found]}` : found ? `is ${found}` : 'is not an image'}`);
  }
  return { ok: true, value: `data:${declared};base64,${bytes.toString('base64')}` };
}

function refused(what: string): Checked {
  return { ok: false, error: `${ALLOWED}; ${what}` };
}

/**
 * Why the bytes are not an SVG a browser draws as one, or null. Its root must
 * be `<svg`, after an optional prolog, comments and whitespace. A DOCTYPE or
 * an entity anywhere is refused: entity expansion can hang the tab that draws
 * the image, `<img>` or not.
 */
function svgProblem(bytes: Uint8Array): string | null {
  const text = asText(bytes);
  if (text === null) return 'this one says SVG but is not text';
  if (/<!(?:DOCTYPE|ENTITY)/i.test(text)) return 'this SVG declares a DOCTYPE or an entity, which a logo may not';
  let rest = text.replace(/^﻿/, '');
  for (;;) {
    const before = rest;
    rest = rest.replace(/^\s+/, '').replace(/^<\?xml[\s\S]*?\?>/, '').replace(/^<!--[\s\S]*?-->/, '');
    if (rest === before) break;
  }
  if (!/^<svg[\s>/]/.test(rest)) return 'this one says SVG but its content is not an <svg> drawing';
  return null;
}

/** A stored logo's type and bytes, to serve; null for a value that is not one. */
export function decodeLogo(stored: string): { mediaType: string; bytes: Buffer } | null {
  const parts = /^data:([^;,]+);base64,(.*)$/s.exec(stored);
  if (!parts || !NAMES[parts[1] ?? '']) return null;
  return { mediaType: parts[1] as string, bytes: Buffer.from(parts[2] ?? '', 'base64') };
}

/** A stored logo's type from its first characters (`settingDigest`'s head), or null. */
export function logoMediaType(head: string): string | null {
  const type = /^data:([^;,]+)[;,]/.exec(head)?.[1] ?? '';
  return NAMES[type] ? type : null;
}

/**
 * The policy the logo is served with: no script source, and a sandbox without
 * `allow-scripts`, so an SVG opened on its own runs nothing either. Its own
 * `<style>` and inline images still draw.
 */
export const LOGO_POLICY = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";

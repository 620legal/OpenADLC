#!/usr/bin/env node
/**
 * Every relative link in the repository's Markdown resolves: the file exists,
 * and an anchor names a heading in it. That covers the HTML in it too, the
 * `src`, `href` and `srcset` of `<img>`, `<a>` and `<picture>`'s `<source>`:
 * a README that centres its pictures that way was skipped, so a picture renamed
 * under it would have shown as a broken image. Run from the checkout:
 *
 *   node tests/check-links.mjs
 *
 * Moving a folder — `skills/` became `crew/skills/` — breaks links in files
 * nobody thinks to open, and GitHub shows a broken one as a 404 a reader hits
 * long after the change merged. `tests/links.test.ts` runs this.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces to hyphens. */
export function anchorOf(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[`*~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // GitHub keeps an underscore inside a word (`$OPENADLC_HOME` is
    // `#openadlc_home`); only `_emphasis_` markers go.
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function anchorsIn(file) {
  const anchors = new Set();
  const counts = new Map();
  let fenced = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (!match) continue;
    const base = anchorOf(match[1]);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
  }
  for (const match of readFileSync(file, 'utf8').matchAll(/<a\s[^>]*?\b(?:name|id)\s*=\s*["']([^"']+)["']/gi)) anchors.add(match[1]);
  return anchors;
}

/**
 * The text with what GitHub does not render as a link blanked out, offsets and
 * line breaks kept: fenced blocks, inline code spans and closed HTML comments.
 * A path quoted in backticks, an example in a fence, or a tag commented out is
 * prose, not a link a reader can follow.
 */
function blankedOut(text) {
  let fenced = false;
  const blank = (span) => span.replace(/[^\n]/g, ' ');
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return blank(line);
      }
      if (fenced) return blank(line);
      return line.replace(/`[^`]*`/g, blank);
    })
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, blank);
}

/**
 * Every link target in Markdown text, as `{ line, target, image }`: Markdown
 * links and images, and the `src`, `href` and `srcset` of any HTML tag (each
 * `srcset` candidate on its own, its `1x` or `640w` descriptor dropped). A tag
 * may span lines; the line is the attribute's. External targets are included;
 * the caller decides what to skip.
 */
export function linkTargets(text) {
  const masked = blankedOut(text);
  const targets = [];
  masked.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      targets.push({ line: index + 1, target: match[2], image: match[1] === '!' });
    }
  });
  const lineAt = (offset) => masked.slice(0, offset).split('\n').length;
  for (const tag of masked.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
    const name = tag[1].toLowerCase();
    for (const attr of tag[0].matchAll(/\s(src|href|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const kind = attr[1].toLowerCase();
      const value = (attr[2] ?? attr[3]).replace(/&amp;/g, '&').trim();
      // A data: URL has commas of its own, and is skipped as a scheme anyway.
      const values =
        kind === 'srcset' && !/^data:/i.test(value)
          ? value.split(',').map((candidate) => candidate.trim().split(/\s+/)[0]).filter(Boolean)
          : [value];
      const image = kind !== 'href' && ['img', 'source', 'image'].includes(name);
      const line = lineAt(tag.index + attr.index + 1);
      for (const target of values) targets.push({ line, target, image });
    }
  }
  return targets.sort((a, b) => a.line - b.line);
}

/** Each broken relative link in one Markdown file, named relative to root, as `file:line → target (why)`. */
export function brokenLinksIn(root, file) {
  const path = join(root, file);
  const broken = [];
  for (const { line, target } of linkTargets(readFileSync(path, 'utf8'))) {
    if (!target || /^(?:[a-z][a-z0-9+.-]*:|#$|\/\/)/i.test(target)) continue;
    const [pathPart, anchor] = target.split('#');
    const resolved = pathPart ? resolve(dirname(path), decodeURIComponent(pathPart)) : path;
    const where = `${file}:${line}`;
    if (!resolved.startsWith(root)) {
      broken.push(`${where} → ${target} (outside the repository)`);
      continue;
    }
    if (!existsSync(resolved)) {
      broken.push(`${where} → ${target} (no such file)`);
      continue;
    }
    if (anchor && statSync(resolved).isFile() && resolved.endsWith('.md') && !anchorsIn(resolved).has(anchor)) {
      broken.push(`${where} → ${target} (no heading #${anchor} in ${relative(root, resolved)})`);
    }
  }
  return broken;
}

/** Each broken relative link in the tracked Markdown, as `file:line → target (why)`. */
export function brokenLinks(root = ROOT) {
  const files = execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  return files.filter((file) => existsSync(join(root, file))).flatMap((file) => brokenLinksIn(root, file));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const broken = brokenLinks();
  for (const line of broken) console.log(line);
  console.log(broken.length === 0 ? 'every relative link resolves' : `${broken.length} broken link(s)`);
  process.exitCode = broken.length === 0 ? 0 : 1;
}

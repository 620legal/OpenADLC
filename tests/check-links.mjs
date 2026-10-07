#!/usr/bin/env node
/**
 * Every relative link in the repository's Markdown resolves: the file exists,
 * and an anchor names a heading in it. Run from the checkout:
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
    // GitHub keeps an underscore inside a word (`$FLEETADLC_HOME` is
    // `#fleetadlc_home`); only `_emphasis_` markers go.
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
  for (const match of readFileSync(file, 'utf8').matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) anchors.add(match[1]);
  return anchors;
}

/** Each broken relative link in the tracked Markdown, as `file:line → target (why)`. */
export function brokenLinks(root = ROOT) {
  const files = execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const broken = [];
  for (const file of files) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    let fenced = false;
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
        if (fenced) return;
        const prose = line.replace(/`[^`]*`/g, '');
        for (const match of prose.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
          const target = match[1];
          if (/^(?:[a-z][a-z0-9+.-]*:|#$|\/\/)/i.test(target) || target.startsWith('mailto:')) continue;
          const [pathPart, anchor] = target.split('#');
          const resolved = pathPart ? resolve(dirname(path), decodeURIComponent(pathPart)) : path;
          const where = `${file}:${index + 1}`;
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
      });
  }
  return broken;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const broken = brokenLinks();
  for (const line of broken) console.log(line);
  console.log(broken.length === 0 ? 'every relative link resolves' : `${broken.length} broken link(s)`);
  process.exitCode = broken.length === 0 ? 0 : 1;
}

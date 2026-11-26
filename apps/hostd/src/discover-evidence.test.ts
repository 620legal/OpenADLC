import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscoverProposal } from '@openadlc/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkEvidence, lineCount, snapshotCommit } from './discover-evidence.js';

/**
 * hostd keeps a Discover proposal's `file:line` only when it exists at the
 * commit the run read (#370). Checked against a real repository: a model
 * points at files it imagined, at lines past a file's end, and at what it
 * wrote itself, and none of those is evidence.
 */

let repo: string;
let commit: string;

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'openadlc-discover-'));
  git('init', '--quiet');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(repo, 'a.ts'), 'one\ntwo\nthree\n');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'b.ts'), 'only line, no newline');
  git('add', '.');
  git('commit', '--quiet', '-m', 'snapshot');
  commit = git('rev-parse', 'HEAD');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

const proposal = (key: string, evidence: { file: string; line: number }[]): DiscoverProposal => ({
  lens: 'improve',
  key,
  title: key,
  description: key,
  status: 'partial',
  evidence,
});

describe('a Discover proposal’s evidence', () => {
  it('keeps a line within a file at the snapshot, and drops one past its end', async () => {
    const result = await checkEvidence(repo, commit, [proposal('a', [{ file: 'a.ts', line: 3 }, { file: 'a.ts', line: 4 }, { file: 'src/b.ts', line: 1 }])]);
    expect(result).toEqual({ proposals: [proposal('a', [{ file: 'a.ts', line: 3 }, { file: 'src/b.ts', line: 1 }])], dropped: 0 });
  });

  it('drops a file that is not there, one outside the repository, a directory, and one only in the worktree', async () => {
    writeFileSync(join(repo, 'worktree-only.ts'), 'written after the snapshot\n');
    mkdirSync(join(repo, '.openadlc-scratch'));
    writeFileSync(join(repo, '.openadlc-scratch', 'notes.md'), 'the session wrote this\n');
    const result = await checkEvidence(repo, commit, [
      proposal('missing', [{ file: 'missing.ts', line: 1 }]),
      proposal('escape', [{ file: '../x', line: 1 }]),
      proposal('directory', [{ file: 'src', line: 1 }]),
      proposal('worktree', [{ file: 'worktree-only.ts', line: 1 }]),
      proposal('scratch', [{ file: '.openadlc-scratch/notes.md', line: 1 }]),
      proposal('kept', [{ file: 'missing.ts', line: 1 }, { file: 'a.ts', line: 1 }]),
    ]);
    // Each left with no evidence is dropped, and counted once.
    expect(result.dropped).toBe(5);
    expect(result.proposals).toEqual([proposal('kept', [{ file: 'a.ts', line: 1 }])]);
  });

  it('reads the commit, not the worktree: a file changed since keeps its old length', async () => {
    writeFileSync(join(repo, 'a.ts'), 'one\n');
    const result = await checkEvidence(repo, commit, [proposal('a', [{ file: 'a.ts', line: 3 }])]);
    expect(result.proposals).toHaveLength(1);
  });

  it('is not fooled into running a command by a path', async () => {
    const result = await checkEvidence(repo, commit, [proposal('shell', [{ file: '$(touch pwned).ts', line: 1 }])]);
    expect(result.dropped).toBe(1);
    expect(existsSync(join(repo, 'pwned'))).toBe(false);
  });

  it('refuses a commit that is not one', async () => {
    await expect(checkEvidence(repo, 'HEAD; rm -rf /', [])).rejects.toThrow(/not a commit/);
  });

  it('reads the snapshot’s commit from HEAD', async () => {
    expect(await snapshotCommit(repo)).toBe(commit);
  });
});

describe('counting a file’s lines', () => {
  it('counts a last line without its newline, and nothing in an empty file', () => {
    expect(lineCount('')).toBe(0);
    expect(lineCount('one\ntwo\n')).toBe(2);
    expect(lineCount('one\ntwo')).toBe(2);
    expect(lineCount('\n')).toBe(1);
  });
});

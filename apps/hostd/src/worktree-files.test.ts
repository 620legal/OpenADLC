import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isWorktreeRefusal,
  MAX_ENTRIES,
  MAX_FILE_BYTES,
  readInside,
  readWorktree,
  type WorktreeFile,
  type WorktreeListing,
  type WorktreeRefusal,
} from './worktree-files.js';

/**
 * A worktree the way a task leaves one: the bot's work, the repository plumbing
 * beside it, and — because a task can write whatever it likes — a symlink out.
 * The fixture is a real directory rather than a mock filesystem, because what is
 * being tested is what `realpath` does with it.
 */
let root: string;
let outside: string;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'fleetadlc-worktree-'));
  root = join(base, 'wt', 'task-live');
  outside = join(base, 'outside');

  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(outside, { recursive: true });

  writeFileSync(join(root, 'README.md'), '# what the bot wrote\n');
  writeFileSync(join(root, 'src', 'server.ts'), 'export const port = 47312;\n');
  writeFileSync(join(root, '.git', 'config'), '[remote "origin"]\n');
  writeFileSync(join(root, '.env'), 'GITHUB_TOKEN=ghu_pretend\n');
  writeFileSync(join(outside, 'secrets.txt'), 'not the bot’s work\n');
});

afterEach(() => {
  rmSync(join(root, '..', '..'), { recursive: true, force: true });
});

function refusal(view: Awaited<ReturnType<typeof readWorktree>>): WorktreeRefusal {
  if (!isWorktreeRefusal(view)) throw new Error(`expected a refusal, got ${JSON.stringify(view).slice(0, 120)}`);
  return view;
}

function listing(view: Awaited<ReturnType<typeof readWorktree>>): WorktreeListing {
  if (isWorktreeRefusal(view) || view.kind !== 'directory') throw new Error('expected a listing');
  return view;
}

function file(view: Awaited<ReturnType<typeof readWorktree>>): WorktreeFile {
  if (isWorktreeRefusal(view) || view.kind !== 'file') throw new Error('expected a file');
  return view;
}

describe('browsing a task’s worktree', () => {
  it('lists the root when no path is asked for', async () => {
    const view = listing(await readWorktree(root, ''));
    expect(view.path).toBe('');
    expect(view.entries.map((entry) => entry.name)).toEqual(['src', 'README.md']);
  });

  it('puts directories first, so the tree does not reshuffle under a poll', async () => {
    const view = listing(await readWorktree(root, ''));
    expect(view.entries[0]).toMatchObject({ name: 'src', kind: 'directory' });
  });

  it('reports a file’s size in the listing, so a big one is visible before opening it', async () => {
    const view = listing(await readWorktree(root, ''));
    expect(view.entries.find((entry) => entry.name === 'README.md')?.size).toBe(21);
  });

  it('descends into a directory', async () => {
    const view = listing(await readWorktree(root, 'src'));
    expect(view.entries.map((entry) => entry.name)).toEqual(['server.ts']);
  });

  it('shows a file the bot just wrote', async () => {
    writeFileSync(join(root, 'src', 'fresh.ts'), 'export const answer = 42;\n');
    const view = file(await readWorktree(root, 'src/fresh.ts'));
    expect(view.content).toBe('export const answer = 42;\n');
    expect(view.truncated).toBe(false);
  });

  it('answers 404 for a path that is not there', async () => {
    expect(refusal(await readWorktree(root, 'src/nothing.ts')).status).toBe(404);
  });
});

describe('a path that leaves the worktree', () => {
  it('refuses ../../../etc/passwd', async () => {
    const view = refusal(await readWorktree(root, '../../../etc/passwd'));
    expect(view.status).toBe(400);
    expect(view.error).toContain('climbs out of the worktree');
  });

  it('refuses an absolute path', async () => {
    // Without this, `/etc/passwd` joins onto the root as `<root>/etc/passwd` on
    // POSIX and reads as an ordinary miss — a refusal that happens to be right
    // for the wrong reason, and wrong the moment the join changes.
    expect(refusal(await readWorktree(root, '/etc/passwd')).status).toBe(400);
  });

  it('refuses a symlink pointing outside, which no syntactic check would catch', async () => {
    // The case the containment check exists for. `escape/secrets.txt` has no
    // `..` in it, is not absolute, and names a file that really is there — only
    // resolving it and asking where it landed refuses this.
    symlinkSync(outside, join(root, 'escape'));
    const view = refusal(await readWorktree(root, 'escape/secrets.txt'));
    expect(view.status).toBe(403);
    expect(view.error).toContain('resolves outside the worktree');
  });

  it('refuses a symlink to a file outside even when the link is the last segment', async () => {
    symlinkSync(join(outside, 'secrets.txt'), join(root, 'secrets.txt'));
    const view = refusal(await readWorktree(root, 'secrets.txt'));
    expect(view.status).toBe(403);
    expect(JSON.stringify(view)).not.toContain('not the bot');
  });

  it('refuses a symlink inside the worktree to a file it will not serve', async () => {
    // The name asked for is innocent; where it lands is the session's token.
    symlinkSync('.env', join(root, 'notes'));
    symlinkSync('.git', join(root, 'plumbing'));
    expect(refusal(await readWorktree(root, 'notes'))).toMatchObject({ status: 403, error: '.env is not served' });
    expect(refusal(await readWorktree(root, 'plumbing/config'))).toMatchObject({ status: 403, error: '.git is not served' });
  });

  it('refuses a FIFO at once, rather than holding a thread until something writes to it', async () => {
    execFileSync('mkfifo', [join(root, 'pipe')]);
    const started = Date.now();
    expect(refusal(await readWorktree(root, 'pipe')).status).toBe(415);
    // Opened directly too, as it would be if the task swapped it in after the look by name.
    expect(refusal(await readInside(realpathSync(root), join(realpathSync(root), 'pipe'), 'pipe')).status).toBe(415);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('serves nothing when the file is swapped for a symlink out after it was checked', async () => {
    // What `resolveInside` found, and then what the task did before the open.
    const realRoot = realpathSync(root);
    const found = join(realRoot, 'src', 'server.ts');

    rmSync(found);
    symlinkSync(join(outside, 'secrets.txt'), found);
    const swappedFile = refusal(await readInside(realRoot, found, 'src/server.ts'));
    expect(swappedFile.status).toBe(403);

    // O_NOFOLLOW sees only the last segment; a directory above it swapped for a
    // symlink is caught by asking afterwards where the path lands.
    writeFileSync(join(outside, 'server.ts'), 'not the bot’s work\n');
    renameSync(join(realRoot, 'src'), join(realRoot, 'src-was'));
    symlinkSync(outside, join(realRoot, 'src'));
    const swappedDirectory = refusal(await readInside(realRoot, found, 'src/server.ts'));
    expect(swappedDirectory.status).toBe(403);
    expect(JSON.stringify(swappedDirectory)).not.toContain('not the bot’s work');

    // And swapped for a way into what is never served, inside the worktree.
    rmSync(join(realRoot, 'src'));
    symlinkSync('.git', join(realRoot, 'src'));
    expect(refusal(await readInside(realRoot, join(realRoot, 'src', 'config'), 'src/config'))).toMatchObject({ status: 403 });
  });

  it('does not follow a symlink when listing, so a listing answers nothing about what is outside', async () => {
    symlinkSync(outside, join(root, 'escape'));
    const view = listing(await readWorktree(root, ''));
    expect(view.entries.find((entry) => entry.name === 'escape')).toMatchObject({ kind: 'other', size: null });
  });

  it('does not mistake a sibling worktree whose name starts with this one’s', async () => {
    // `startsWith` without the separator would read `…/wt/task-live-stolen` as
    // being inside `…/wt/task-live`.
    const sibling = `${root}-stolen`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'plans.md'), 'another task’s work\n');
    symlinkSync(sibling, join(root, 'sibling'));

    expect(refusal(await readWorktree(root, 'sibling/plans.md')).status).toBe(403);
  });
});

describe('what is never served', () => {
  it('refuses .git, which names the mirror on the host and can hold a credential', async () => {
    expect(refusal(await readWorktree(root, '.git/config')).status).toBe(403);
  });

  it('refuses a .env the session wrote, whatever else the path says', async () => {
    const view = refusal(await readWorktree(root, '.env'));
    expect(view.status).toBe(403);
    expect(JSON.stringify(view)).not.toContain('ghu_pretend');
  });

  it('refuses a .env variant, because .env.local is the same file by another name', async () => {
    writeFileSync(join(root, '.env.local'), 'ANTHROPIC_API_KEY=sk-pretend\n');
    expect(refusal(await readWorktree(root, '.env.local')).status).toBe(403);
  });

  it('leaves them out of the listing rather than showing what it will not open', async () => {
    const view = listing(await readWorktree(root, ''));
    expect(view.entries.map((entry) => entry.name)).not.toContain('.git');
    expect(view.entries.map((entry) => entry.name)).not.toContain('.env');
  });
});

describe('a response that has to stay bounded', () => {
  it('caps a file a bot made too big to send, and says it did', async () => {
    // A bot can write two gigabytes. The cap is the difference between a browser
    // seeing a large file and hostd reading one into memory to serve it.
    const size = MAX_FILE_BYTES + 4096;
    writeFileSync(join(root, 'huge.log'), 'x'.repeat(size));

    const view = file(await readWorktree(root, 'huge.log'));
    expect(view.size).toBe(size);
    expect(view.bytes).toBe(MAX_FILE_BYTES);
    expect(view.truncated).toBe(true);
    expect(view.content.length).toBe(MAX_FILE_BYTES);
  });

  it('caps a directory with more entries than anyone will read', async () => {
    const many = join(root, 'many');
    mkdirSync(many, { recursive: true });
    for (let index = 0; index < MAX_ENTRIES + 10; index += 1) {
      writeFileSync(join(many, `file-${String(index).padStart(4, '0')}.txt`), 'x');
    }

    const view = listing(await readWorktree(root, 'many'));
    expect(view.entries).toHaveLength(MAX_ENTRIES);
    expect(view.truncated).toBe(true);
  });

  it('says a binary is not text rather than sending a screenful of replacement characters', async () => {
    writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]));
    const view = refusal(await readWorktree(root, 'logo.png'));
    expect(view.status).toBe(415);
    expect(view.error).toContain('not a text file');
  });
});

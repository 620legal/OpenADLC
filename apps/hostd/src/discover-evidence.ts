import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { evidenceFrom, type DiscoverEvidence, type DiscoverProposal } from '@openadlc/shared';

/**
 * A Discover run's evidence, checked against the snapshot it read (#370,
 * docs/adr/0089-a-discover-run-is-an-intake-task-whose-proposals-hostd-checks-against-its-snapshot.md).
 *
 * "Evidence for anything it says exists" holds only if code checks it: a
 * model names a file it imagined as readily as one it opened. hostd has the
 * clone and the bridge does not, so the runner checks each `file:line` here
 * before anything reaches the bridge. A line is kept only when the file is a
 * file at `commit` — the clone's HEAD, read before the model ran — and the
 * line is within it. A file the session wrote, under `.openadlc-scratch/` or
 * anywhere else, is not in that commit, so it can never be evidence.
 *
 * git is run with `execFile`, never through a shell: the path is the model's
 * words, and one written as `$(…)` or `; rm` would otherwise be a command.
 */

const run = promisify(execFile);

/** The largest file whose lines are counted; one larger is not evidence, since nobody reads a line in it from a proposal. */
const MAX_BLOB_BYTES = 64 * 1024 * 1024;

/** The number of lines in a file's text: a last line without its newline counts. */
export function lineCount(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) count += 1;
  return text.endsWith('\n') ? count : count + 1;
}

/**
 * Keeps each proposal's evidence that exists at `commit`, and drops a
 * proposal left with none. `dropped` counts the proposals dropped, not the
 * lines.
 */
export async function checkEvidence(
  worktree: string,
  commit: string,
  proposals: readonly DiscoverProposal[],
): Promise<{ proposals: DiscoverProposal[]; dropped: number }> {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`the snapshot's commit is not a commit: ${commit.slice(0, 60)}`);
  // Each path once, however many proposals point into it: its line count, or null when it is no file at the commit.
  const lines = new Map<string, Promise<number | null>>();
  const linesIn = (file: string): Promise<number | null> => {
    let known = lines.get(file);
    if (!known) {
      known = countLines(worktree, commit, file);
      lines.set(file, known);
    }
    return known;
  };

  const kept: DiscoverProposal[] = [];
  let dropped = 0;
  for (const proposal of proposals) {
    const evidence: DiscoverEvidence[] = [];
    for (const one of proposal.evidence) {
      // Checked again here: what reaches git must be a relative path with no way out.
      const parsed = evidenceFrom(one);
      if (!parsed) continue;
      const total = await linesIn(parsed.file);
      if (total !== null && parsed.line <= total) evidence.push(parsed);
    }
    if (evidence.length === 0) {
      dropped += 1;
      continue;
    }
    kept.push({ ...proposal, evidence });
  }
  return { proposals: kept, dropped };
}

/** How many lines `file` has at `commit`, or null when it is not a file there. */
async function countLines(worktree: string, commit: string, file: string): Promise<number | null> {
  const object = `${commit}:${file}`;
  try {
    // A directory is a tree, and `git show` of one lists its entries, which
    // would count as lines.
    const { stdout: type } = await run('git', ['cat-file', '-t', object], { cwd: worktree });
    if (type.trim() !== 'blob') return null;
    const { stdout } = await run('git', ['cat-file', 'blob', object], { cwd: worktree, maxBuffer: MAX_BLOB_BYTES, encoding: 'utf8' });
    return lineCount(stdout);
  } catch {
    return null;
  }
}

/** The clone's HEAD, which the run's evidence is checked against; read before the model runs. */
export async function snapshotCommit(worktree: string): Promise<string> {
  const { stdout } = await run('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: worktree });
  const commit = stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`git answered ${commit.slice(0, 60)} for HEAD`);
  return commit;
}

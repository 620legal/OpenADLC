import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYamlFile } from '@fleetadlc/shared';
import { describe, expect, it } from 'vitest';

/**
 * Every action a workflow runs, and every service image, named by something
 * that cannot move.
 *
 * `actions/checkout@v4` is a tag, and a tag is moved by whoever holds the
 * repository: after a takeover, as with tj-actions/changed-files, the next run
 * executes the new code. Here that is the job whose `ci` the merge line
 * trusts, the one that uploads the tree a later push skips its tests for, and
 * the one that holds `production`. So each `uses:` names a commit, with its
 * release in a comment for the reader and for Dependabot
 * (.github/dependabot.yml), and each service image a digest.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIRECTORIES = [join(ROOT, '.github', 'workflows'), join(ROOT, 'crew', 'templates', 'repo', '.github', 'workflows')];

interface Workflow {
  jobs?: Record<string, { steps?: { uses?: string }[]; services?: Record<string, { image?: string }> }>;
}

const files = DIRECTORIES.flatMap((directory) =>
  readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => join(directory, name)),
);

describe('what the workflows run', () => {
  it('finds the workflows', () => {
    // Guards the walk: with nothing found, every check below passes.
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it.each(files.map((file) => [file.slice(ROOT.length + 1), file]))('%s names each action by a commit', (_name, file) => {
    const workflow = parseYamlFile(file) as Workflow;
    for (const [job, body] of Object.entries(workflow.jobs ?? {})) {
      for (const step of body.steps ?? []) {
        if (!step.uses || step.uses.startsWith('./')) continue;
        expect(step.uses, `${job}: ${step.uses}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      }
      for (const [service, { image }] of Object.entries(body.services ?? {})) {
        expect(image ?? '', `${job}.services.${service}`).toMatch(/@sha256:[0-9a-f]{64}$/);
      }
    }
  });

  it.each(files.map((file) => [file.slice(ROOT.length + 1), file]))('%s says which release each pin is', (_name, file) => {
    // The comment is all a reader has to tell one commit from another.
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const uses = /^\s*-?\s*uses:\s*(\S+)(.*)$/.exec(line);
      if (!uses || uses[1]!.startsWith('./')) continue;
      expect(uses[2], line.trim()).toMatch(/^ # v\d+\.\d+\.\d+$/);
    }
  });

  it.each(files.map((file) => [file.slice(ROOT.length + 1), file]))('%s checks each tool it downloads against a checksum', (_name, file) => {
    // A release asset is as movable as a tag: actionlint and gitleaks are
    // fetched by URL, so the bytes are what is pinned.
    const text = readFileSync(file, 'utf8');
    for (const [, path, url] of text.matchAll(/curl\s.*?-o\s+(\S+)\s+(https:\/\/\S+)/g)) {
      expect(url, url).toMatch(/\/releases\/download\/v\d+\.\d+\.\d+\//);
      expect(text, `${path} from ${url}`).toMatch(new RegExp(`echo "[0-9a-f]{64}  ${path!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" \\| sha256sum -c -`));
    }
  });
});

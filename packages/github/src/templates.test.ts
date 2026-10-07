import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RuleApi } from './rules.js';
import {
  applyRepoTemplates,
  approversFor,
  checkRepoTemplates,
  CI_WORKFLOW,
  CURRENT_CI_TEMPLATE,
  EARLIER_CI_TEMPLATES,
  isEarlierCiTemplate,
  makefileLacks,
  TEMPLATE_FILES,
  templateBody,
  templateHash,
  withApprovers,
} from './templates.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * A fake GitHub holding a set of paths that exist. Nothing here reaches the real
 * repository: writing files into somebody's repository is not something a test
 * gets to rehearse against the live thing.
 */
function fake(present: string[], refuse?: string) {
  const writes: { path: string; body: unknown }[] = [];
  const api: RuleApi = {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const file = path.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, '');
      if (method === 'GET') {
        if (!present.includes(file)) throw new Error('404');
        return { path: file } as T;
      }
      if (method === 'PUT') {
        // One file GitHub will not take, which is the case that used to end the
        // loop and lose every file after it.
        if (file === refuse) throw new Error(`${path} → 409: path conflicts with an existing directory`);
        writes.push({ path: file, body });
        present.push(file);
        return {} as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { api, writes };
}

describe('what a managed repository is missing', () => {
  it('reports every template that is not there, and why it matters', async () => {
    // "missing" on its own tells an operator nothing about whether to care.
    const { api } = fake([]);
    const reports = await checkRepoTemplates(api, 'owner/repo');

    expect(reports).toHaveLength(TEMPLATE_FILES.length);
    expect(reports.every((report) => report.state === 'missing')).toBe(true);
    expect(reports.every((report) => report.detail.length > 0)).toBe(true);
  });

  it('is quiet about a repository that has them all', async () => {
    const { api } = fake([...TEMPLATE_FILES]);
    const reports = await checkRepoTemplates(api, 'owner/repo');
    expect(reports.every((report) => report.state === 'present')).toBe(true);
  });

  it('does not call a repository’s own AGENTS.md drifted', async () => {
    // An `AGENTS.md` that matched the template would be one nobody had filled
    // in. A check that complained about divergence would be telling operators
    // to undo their own work.
    const { api } = fake(['AGENTS.md']);
    const reports = await checkRepoTemplates(api, 'owner/repo');
    expect(reports.find((report) => report.name === 'AGENTS.md')?.state).toBe('present');
  });

  it('changes nothing', async () => {
    const { api, writes } = fake([]);
    await checkRepoTemplates(api, 'owner/repo');
    expect(writes).toEqual([]);
  });
});

describe('writing the missing ones', () => {
  it('writes what is absent', async () => {
    const { api, writes } = fake([]);
    const outcomes = await applyRepoTemplates(api, { fullName: 'owner/repo', root: ROOT });

    expect(writes.map((write) => write.path).sort()).toEqual([...TEMPLATE_FILES].sort());
    expect(outcomes.every((outcome) => outcome.action === 'created')).toBe(true);
  });

  it('never overwrites a file the repository already has', async () => {
    // What a repository says about itself is its own. This step fills gaps.
    const { api, writes } = fake(['AGENTS.md', 'Makefile']);
    const outcomes = await applyRepoTemplates(api, { fullName: 'owner/repo', root: ROOT });

    expect(writes.map((write) => write.path)).not.toContain('AGENTS.md');
    expect(writes.map((write) => write.path)).not.toContain('Makefile');
    expect(outcomes.find((outcome) => outcome.name === 'AGENTS.md')?.action).toBe('unchanged');
    expect(outcomes.find((outcome) => outcome.name === 'Makefile')?.action).toBe('unchanged');
  });

  it('writes nothing on a dry run, and says what it would have written', async () => {
    // The first thing an operator should be able to do is find out what this
    // would do to their repository.
    const { api, writes } = fake([]);
    const outcomes = await applyRepoTemplates(api, { fullName: 'owner/repo', root: ROOT, dryRun: true });

    expect(writes).toEqual([]);
    expect(outcomes.every((outcome) => outcome.action === 'skipped')).toBe(true);
    expect(outcomes[0]?.detail).toContain('would write it');
  });

  it('sends the real contents, base64 as the API wants them', async () => {
    const { api, writes } = fake([]);
    await applyRepoTemplates(api, { fullName: 'owner/repo', root: ROOT });

    const written = writes.find((write) => write.path === 'AGENTS.md')?.body as { content: string };
    expect(Buffer.from(written.content, 'base64').toString('utf8')).toBe(templateBody('AGENTS.md', ROOT));
  });

  it('can read every file it declares', () => {
    // A path in the list with no file behind it fails at apply time, against a
    // real repository, halfway through.
    for (const file of TEMPLATE_FILES) {
      expect(() => templateBody(file, ROOT), file).not.toThrow();
      expect(templateBody(file, ROOT).length).toBeGreaterThan(0);
    }
  });
});

describe('one file GitHub will not take', () => {
  /**
   * Found on a real repository, though through the environments rather than
   * here: a single refusal inside the loop ended the whole run, and everything
   * after it went unwritten with nothing said about which.
   */
  it('does not cost the files after it', async () => {
    const refused = TEMPLATE_FILES[1] as string;
    const { api, writes } = fake([], refused);

    const outcomes = await applyRepoTemplates(api, { fullName: 'janedoe/fleetadlc-testbed', root: ROOT });

    expect(outcomes).toHaveLength(TEMPLATE_FILES.length);
    expect(writes).toHaveLength(TEMPLATE_FILES.length - 1);
  });

  it('is reported as the one that was refused, with the reason', async () => {
    const refused = TEMPLATE_FILES[1] as string;
    const { api } = fake([], refused);

    const outcomes = await applyRepoTemplates(api, { fullName: 'janedoe/fleetadlc-testbed', root: ROOT });
    const skipped = outcomes.filter((one) => one.action === 'skipped');

    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.name).toBe(refused);
    expect(skipped[0]?.detail).toMatch(/409/);
  });
});

/** A repository whose `AGENTS.md` says `body`, and every other template present. */
function withAgents(body: string) {
  const writes: { path: string; body: { content: string; sha?: string } }[] = [];
  const api: RuleApi = {
    async request<T>(method: string, path: string, sent?: unknown): Promise<T> {
      const file = path.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, '');
      if (method === 'GET') {
        if (file === 'AGENTS.md') return { path: file, sha: 'abc', content: Buffer.from(body).toString('base64') } as T;
        return { path: file } as T;
      }
      if (method === 'PUT') {
        writes.push({ path: file, body: sent as { content: string; sha?: string } });
        return {} as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { api, writes };
}

const decoded = (content: string): string => Buffer.from(content, 'base64').toString('utf8');

describe('who approves the human-review paths', () => {
  it('writes a new AGENTS.md naming the approvers, never the template’s @owner', async () => {
    // The template's placeholder was committed as it was, and the first thing a
    // new install showed was a blocking card about OpenADLC's own file.
    const { api, writes } = fake([]);
    await applyRepoTemplates(api, { fullName: 'owner/repo', root: ROOT, approvers: ['janedoe', 'sam'] });
    const agents = decoded((writes.find((write) => write.path === 'AGENTS.md')!.body as { content: string }).content);
    expect(agents).toContain('- `config/` @janedoe @sam');
    expect(agents).not.toMatch(/@owner\b/);
  });

  it('keeps the placeholder with nobody to name, for the repository check to ask about', () => {
    expect(withApprovers('- `config/` @owner', [])).toBe('- `config/` @owner');
    expect(withApprovers('@ownership @owner', ['sam'])).toBe('@ownership @sam');
  });

  it('replaces the placeholder and never a real login, team or address that starts with it', async () => {
    // `@owner\b` matched `@owner-ops`, and apply rewrote who approves infra/.
    const theirs = '- `infra/` @owner-ops\n- `docs/` @owner/platform\nWrite to security@owner.example.\n';
    expect(withApprovers(theirs, ['sam'])).toBe(theirs);
    expect(withApprovers('- `config/` @owner\nask @Owner.\n@owner first', ['sam'])).toBe('- `config/` @sam\nask @sam.\n@sam first');

    const { api, writes } = withAgents(`## Human review\n\n${theirs}`);
    const reports = await checkRepoTemplates(api, 'owner/repo', { approvers: ['sam'] });
    expect(reports.find((report) => report.name === 'AGENTS.md')?.state).toBe('present');
    await applyRepoTemplates(api, { fullName: 'owner/repo', root: ROOT, approvers: ['sam'] });
    expect(writes).toEqual([]);
  });

  it('reports and replaces the placeholder in an AGENTS.md it wrote before, and only that', async () => {
    const { api, writes } = withAgents('## Human review\n\n- `config/` @owner\n- `infra/` @owner\n');
    const reports = await checkRepoTemplates(api, 'owner/repo', { approvers: ['janedoe'] });
    expect(reports.find((report) => report.name === 'AGENTS.md')).toMatchObject({ state: 'drifted' });

    const outcomes = await applyRepoTemplates(api, { fullName: 'owner/repo', root: ROOT, approvers: ['janedoe'] });
    expect(outcomes.find((outcome) => outcome.name === 'AGENTS.md')).toMatchObject({ action: 'updated' });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body.sha).toBe('abc');
    expect(decoded(writes[0]!.body.content)).toBe('## Human review\n\n- `config/` @janedoe\n- `infra/` @janedoe\n');
  });

  it('leaves an AGENTS.md somebody filled in alone', async () => {
    const { api, writes } = withAgents('## Human review\n\n- `config/` @janedoe\n');
    const reports = await checkRepoTemplates(api, 'owner/repo', { approvers: ['sam'] });
    expect(reports.find((report) => report.name === 'AGENTS.md')?.state).toBe('present');
    await applyRepoTemplates(api, { fullName: 'owner/repo', root: ROOT, approvers: ['sam'] });
    expect(writes).toEqual([]);
  });
});

describe('who is named as approving', () => {
  const asks = (answers: Record<string, unknown>): RuleApi => ({
    async request<T>(_method: string, path: string): Promise<T> {
      const key = Object.keys(answers).find((one) => path.startsWith(one));
      if (!key || answers[key] instanceof Error) throw answers[key ?? ''] ?? new Error('404');
      return answers[key] as T;
    },
  });

  it('is the install’s people when it names them, without asking GitHub', async () => {
    expect(await approversFor(asks({}), 'acme/api', { humans: ['janedoe'], crew: [] })).toEqual(['janedoe']);
  });

  it('is the repository’s admins, never a crew account or a bot', async () => {
    const api = asks({
      '/repos/acme/api/collaborators': [
        { login: 'sam', type: 'User' },
        { login: 'acme-lead', type: 'User' },
        { login: 'renovate[bot]', type: 'Bot' },
        { login: 'ada', type: 'User' },
      ],
    });
    expect(await approversFor(api, 'acme/api', { humans: [], crew: ['acme-lead'] })).toEqual(['ada', 'sam']);
  });

  it('is a personal repository’s owner, and nobody for an organization it cannot see into', async () => {
    const personal = asks({ '/repos/janedoe/api/collaborators': [], '/repos/janedoe/api': { owner: { login: 'janedoe', type: 'User' } } });
    expect(await approversFor(personal, 'janedoe/api', { humans: [], crew: [] })).toEqual(['janedoe']);
    // Asked as the automation account, which cannot list admins: nobody, never the organization.
    const organization = asks({ '/repos/acme/api/collaborators': new Error('403'), '/repos/acme/api': { owner: { login: 'acme', type: 'Organization' } } });
    expect(await approversFor(organization, 'acme/api', { humans: [], crew: [] })).toEqual([]);
  });
});

describe('a repository’s own Makefile', () => {
  function withMakefile(body: string) {
    const writes: string[] = [];
    const api: RuleApi = {
      async request<T>(method: string, path: string): Promise<T> {
        const file = path.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, '');
        if (method === 'GET') {
          if (file === 'Makefile') return { path: file, content: Buffer.from(body).toString('base64'), sha: 'mk1' } as T;
          return { path: file } as T;
        }
        writes.push(file);
        return {} as T;
      },
    };
    return { api, writes };
  }

  it('is reported when it has no target the ci workflow runs, and left alone', async () => {
    // It read as present, and every pull request's `ci` then failed with
    // "No rule to make target 'setup'".
    const { api, writes } = withMakefile('.PHONY: build test setup\nbuild:\n\tgo build ./...\ntest:\n\tgo test ./...\n');
    const report = (await checkRepoTemplates(api, 'owner/repo')).find((one) => one.name === 'Makefile');
    expect(report).toMatchObject({ state: 'drifted', detail: expect.stringContaining('no `setup` or `ci` target') });

    const outcomes = await applyRepoTemplates(api, { fullName: 'owner/repo', root: ROOT });
    expect(outcomes.find((one) => one.name === 'Makefile')).toMatchObject({ action: 'skipped', detail: expect.stringContaining('no `setup` or `ci` target') });
    expect(writes).toEqual([]);
  });

  it('is present when it has both, however they are declared', async () => {
    for (const body of ['setup:\n\tnpm ci\nci: setup\n\tnpm test\n', 'setup ci::\n\ttrue\n', templateBody('Makefile', ROOT)]) {
      expect(makefileLacks(body), body).toEqual([]);
    }
    expect(makefileLacks('CI := 1\nsetup := 2\nci:\n')).toEqual(['setup']);
  });
});

describe('a CI workflow OpenADLC wrote earlier', () => {
  /** A repository with every template, its CI workflow holding `body`. */
  function withWorkflow(body: string) {
    const writes: { path: string; body: { message: string; content: string; sha?: string } }[] = [];
    const api: RuleApi = {
      async request<T>(method: string, path: string, sent?: unknown): Promise<T> {
        const file = path.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, '');
        if (method === 'GET') {
          if (file === CI_WORKFLOW) return { path: file, content: Buffer.from(body).toString('base64'), sha: 'wf1' } as T;
          return { path: file } as T;
        }
        writes.push({ path: file, body: sent as { message: string; content: string; sha?: string } });
        return {} as T;
      },
    };
    return { api, writes };
  }

  // The ones that shipped before this one, exactly as they were written into
  // repositories: Fleet's, and OpenADLC's first, second and third. Each is
  // offered with what bringing it up to date changes for it: the third already
  // ran only what a change needs, and differs only by the SPDX line.
  const RUNS_LESS = { says: 'runs only what a change needs', title: 'run only what a change needs' };
  const SPDX = { says: 'adds the SPDX line saying the file is also 0BSD', title: 'add the SPDX line saying it is also 0BSD' };
  const versions = [
    { name: 'Fleet’s', file: 'ci-template-fleet.yml', ...RUNS_LESS },
    { name: 'OpenADLC’s first', file: 'ci-template-fleetadlc-1.yml', ...RUNS_LESS },
    { name: 'OpenADLC’s second', file: 'ci-template-fleetadlc-2.yml', ...RUNS_LESS },
    { name: 'OpenADLC’s third', file: 'ci-template-fleetadlc-3.yml', ...SPDX },
  ].map((version) => ({ ...version, body: readFileSync(join(import.meta.dirname, 'fixtures', version.file), 'utf8') }));
  const shipped = versions.map((version) => version.body);

  it('knows the template as it ships now, and each earlier one by the file it was', () => {
    // Changed the template? Put the hash it had into EARLIER_CI_TEMPLATES, with
    // what bringing it up to date changes, so repositories still holding it are
    // offered the new one; add the old file under fixtures/, and set
    // CURRENT_CI_TEMPLATE to the new hash.
    expect(templateHash(templateBody(CI_WORKFLOW, ROOT))).toBe(CURRENT_CI_TEMPLATE);
    expect(EARLIER_CI_TEMPLATES.has(CURRENT_CI_TEMPLATE)).toBe(false);
    expect(shipped.map(templateHash).sort()).toEqual([...EARLIER_CI_TEMPLATES.keys()].sort());
  });

  it.each(versions)(
    'reports $name as one to bring up to date, says what that changes, and writes the current template over it, as the app',
    async ({ body, says, title }) => {
      const { api, writes } = withWorkflow(body);
      const reports = await checkRepoTemplates(api, 'owner/repo');
      expect(reports.find((report) => report.name === CI_WORKFLOW)).toMatchObject({
        state: 'drifted',
        detail: expect.stringContaining(says),
      });

      const dry = await applyRepoTemplates(api, { fullName: 'owner/repo', root: ROOT, dryRun: true });
      expect(dry.find((outcome) => outcome.name === CI_WORKFLOW)).toMatchObject({
        action: 'skipped',
        detail: expect.stringContaining(says),
      });
      expect(writes).toEqual([]);

      const outcomes = await applyRepoTemplates(api, { fullName: 'owner/repo', root: ROOT });
      expect(outcomes.find((outcome) => outcome.name === CI_WORKFLOW)).toMatchObject({
        action: 'updated',
        detail: expect.stringContaining(says),
      });
      expect(writes).toHaveLength(1);
      expect(writes[0]!.body.message.split('\n')[0]).toBe(`Bring ${CI_WORKFLOW} up to date: ${title}`);
      expect(writes[0]!.body.message).toContain(says);
      expect(writes[0]!.body.sha).toBe('wf1');
      expect(Buffer.from(writes[0]!.body.content, 'base64').toString('utf8')).toBe(templateBody(CI_WORKFLOW, ROOT));
    },
  );

  it('does not tell a repository on the third template that its CI will run differently', async () => {
    const third = versions.find((version) => version.file === 'ci-template-fleetadlc-3.yml')!;
    const { api, writes } = withWorkflow(third.body);
    const detail = (await checkRepoTemplates(api, 'owner/repo')).find((report) => report.name === CI_WORKFLOW)?.detail;
    expect(detail).not.toContain('runs only what a change needs');
    expect(detail).not.toContain('stops a hung run');

    await applyRepoTemplates(api, { fullName: 'owner/repo', root: ROOT });
    expect(writes[0]!.body.message).not.toContain('run only what a change needs');
  });

  it('leaves a workflow somebody changed alone, by a single byte, and the current one too', async () => {
    for (const body of [`${shipped[1]}# ours\n`, templateBody(CI_WORKFLOW, ROOT)]) {
      const { api, writes } = withWorkflow(body);
      expect(isEarlierCiTemplate(body)).toBe(false);
      expect((await checkRepoTemplates(api, 'owner/repo')).find((report) => report.name === CI_WORKFLOW)?.state).toBe('present');
      await applyRepoTemplates(api, { fullName: 'owner/repo', root: ROOT });
      expect(writes).toEqual([]);
    }
  });
});

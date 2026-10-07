import { describe, expect, it } from 'vitest';
import { GitHubApiError } from './client.js';
import { CONFIG_FILES, loginsNamed, loginsNamedIn, readConfigFiles, touchesConfig } from './repo-config.js';

describe('the logins a configuration file names', () => {
  it('reads each owner in CODEOWNERS, and not a team or an email', () => {
    const text = '# owners\n* @janedoe\n/docs/ @exampleco/writers docs@example.com @someone-else\n';
    expect(loginsNamedIn('.github/CODEOWNERS', text)).toEqual([
      { login: 'janedoe', file: '.github/CODEOWNERS', line: 2, as: 'code-owner' },
      { login: 'someone-else', file: '.github/CODEOWNERS', line: 3, as: 'code-owner' },
    ]);
  });

  it('reads the human review rules of AGENTS.md as reviewers, and other mentions as mentions', () => {
    const text = [
      '# Agent notes',
      '',
      'Ask @janedoe about anything here, or mail jane@example.com.',
      '',
      '```bash',
      'npm i @decorator',
      '```',
      '',
      '## Human review',
      '',
      '- `config/` @janedoe-reviewer',
      '',
      'Install `@scope/pkg` and `@inline`.',
    ].join('\n');
    expect(loginsNamedIn('AGENTS.md', text)).toEqual([
      { login: 'janedoe-reviewer', file: 'AGENTS.md', line: 11, as: 'human-review' },
      { login: 'janedoe', file: 'AGENTS.md', line: 3, as: 'mention' },
    ]);
  });

  it('skips an HTML comment, also one that runs over several lines, and keeps the line numbers after it', () => {
    const text = ['## What changed', '<!--', '  Ask @placeholder-reviewer to look,', '  or @nobody-at-all. -->', 'Reviewed by @janedoe <!-- not @someone -->'].join('\n');
    expect(loginsNamedIn('.github/pull_request_template.md', text)).toEqual([
      { login: 'janedoe', file: '.github/pull_request_template.md', line: 5, as: 'mention' },
    ]);
  });

  it('reads only comments in a workflow or a Makefile, whose code is full of @', () => {
    const makefile = 'setup:\n\t@echo setting up # ask @janedoe\n\tnpx foo@latest "$$@"\n';
    expect(loginsNamedIn('Makefile', makefile)).toEqual([{ login: 'janedoe', file: 'Makefile', line: 2, as: 'mention' }]);
    const workflow = 'steps:\n  - uses: actions/checkout@v4\n  - run: pnpm add @fleetadlc/shared\n';
    expect(loginsNamedIn('.github/workflows/ci.yml', workflow)).toEqual([]);
  });

  it('lists every file’s, in the order the files are read', () => {
    const named = loginsNamed({
      text: new Map([
        ['.github/CODEOWNERS', '* @lead\n'],
        ['AGENTS.md', '## Human review\n- `infra/` @janedoe\n'],
      ]),
      absent: [],
      unreadable: [],
    });
    expect(named.map((one) => `${one.file}:${one.login}`)).toEqual(['AGENTS.md:janedoe', '.github/CODEOWNERS:lead']);
  });
});

describe('reading the configuration files', () => {
  it('tells a file that is not there from one GitHub would not give', async () => {
    const api = {
      async request<T>(_method: string, path: string): Promise<T> {
        if (path.startsWith('/repos/exampleco/api/contents/AGENTS.md?ref=main')) {
          return { content: Buffer.from('## Human review\n').toString('base64'), encoding: 'base64' } as T;
        }
        if (path.startsWith('/repos/exampleco/api/contents/Makefile')) throw new GitHubApiError(502, path, 'bad gateway');
        throw new GitHubApiError(404, path, '{"message":"Not Found"}');
      },
    };
    const files = await readConfigFiles(api, 'exampleco/api', 'main');
    expect(files.text.get('AGENTS.md')).toBe('## Human review\n');
    expect(files.unreadable).toEqual(['Makefile']);
    expect(files.absent).toHaveLength(CONFIG_FILES.length - 2);
  });

  it('knows which changed files are ones it reads', () => {
    expect(touchesConfig(['src/index.ts', '.github/CODEOWNERS'])).toBe(true);
    expect(touchesConfig(['src/index.ts'])).toBe(false);
  });
});

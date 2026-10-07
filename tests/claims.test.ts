import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A status table that overstates is worse than none, because it is what the next
 * person plans from.
 *
 * `docs/platform-plan.md` §11 claimed the revert path needed "a live deploy to
 * exercise" when there was no deploy path at all, and listed the egress
 * allowlist among things "built and tested" when it was a metadata key nothing
 * read. Both were repeated as plans by whoever read them next.
 *
 * Prose cannot be checked. What can be checked is that every file the table
 * offers as evidence exists — a row naming a suite that was renamed or never
 * written is the cheapest way for the table to start lying again, and it is the
 * one failure mode a test can catch.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const plan = readFileSync(join(ROOT, 'docs', 'platform-plan.md'), 'utf8');

/** The "What is proven, and how" table, which is where the evidence lives. */
function evidenceSection(): string {
  const start = plan.indexOf('### What is proven, and how');
  expect(start, 'the plan no longer has a "What is proven" section').toBeGreaterThan(-1);
  const end = plan.indexOf('\n## ', start);
  return plan.slice(start, end < 0 ? undefined : end);
}

/** Every `path/like/this.ts` in backticks. */
function citedPaths(section: string): string[] {
  const cited = [...section.matchAll(/`([\w./-]+\.(?:mjs|ts|tf|yml|yaml))`/g)].map((match) => match[1]!);
  return [...new Set(cited)];
}

describe('what the plan offers as evidence', () => {
  const section = evidenceSection();
  const paths = citedPaths(section);

  it('cites something at all', () => {
    // A guard on the parser rather than on the plan: if the table's shape
    // changes and nothing matches, every assertion below passes vacuously.
    expect(paths.length).toBeGreaterThan(8);
  });

  it.each(paths)('%s exists', (path) => {
    expect(existsSync(join(ROOT, path)), `${path} is cited as evidence and is not in the repository`).toBe(true);
  });

  it('does not claim the deploy path has ever run', () => {
    // This used to assert "there is no deploy path", which was the honest answer
    // until the deploy path was built. It is now built and has still never deployed
    // anything: no environment exists to deploy to, so no deployment has ever
    // been created and nothing GitHub does with one has been watched. The
    // overstatement to guard against has moved rather than gone — a row reading
    // "built" invites the next person to plan as if a deploy had been seen.
    const sequence = plan.slice(plan.indexOf('## 11. Build sequence'), plan.indexOf('### What is proven'));
    const p2 = sequence.split('\n').find((line) => line.startsWith('| P2 '));
    expect(p2).toBeDefined();
    expect(p2).toContain('built and untried');
  });

  it('does not call the cloud module tested', () => {
    // It has been applied once, and only some of what it promises was seen
    // working. `terraform validate` passed on a module whose firewall denied
    // the bridge and whose IAP binding pointed at nothing, so the row says
    // which parts were seen and sends the rest to the unverified log.
    const sequence = plan.slice(plan.indexOf('## 11. Build sequence'), plan.indexOf('### What is proven'));
    const p5 = sequence.split('\n').find((line) => line.startsWith('| P5 '));
    expect(p5).toBeDefined();
    expect(p5).toContain('applied once');
    expect(p5).toContain('unverified.md');
    expect(p5).not.toMatch(/cloud module is \*\*(built and )?tested/);
  });

  it('sends the reader to the unverified log for everything else', () => {
    // The table's honesty depends on there being somewhere for the rest to go.
    expect(section).toContain('unverified.md');
    expect(existsSync(join(ROOT, 'docs', 'unverified.md'))).toBe(true);
  });

  it('carries no check counts, which go stale between writing and reading', () => {
    // `tests/pipeline.mjs, 47 checks` was written when there were 47. There are
    // not 47 now, and nobody noticed — the number is the part that rots, and
    // the suite reports its own.
    expect(section).not.toMatch(/\d+ checks/);
  });
});

describe('where a task can connect', () => {
  // The README promised every task "reaches only GitHub, package registries and
  // its model", and the security notes repeated it. Only the Google Cloud
  // module enforces that, with a proxy and the host's iptables; a laptop or
  // compose install puts tasks on an ordinary network. Someone who trusts the
  // promise believes a prompt-injected bot cannot send its token anywhere, so
  // each place that makes it has to say which install keeps it.
  const read = (...path: string[]) => readFileSync(join(ROOT, ...path), 'utf8');

  it('names infra/gcp in the README bullet that says where a task reaches', () => {
    const bullets = read('README.md').split(/\n(?=- )/);
    const bullet = bullets.find((text) => /reaches only\s+GitHub/.test(text));
    expect(bullet, 'the README no longer says where a task reaches').toBeDefined();
    expect(bullet).toContain('infra/gcp');
  });

  it('names infra/gcp in the first paragraph of the Egress section', () => {
    const security = read('docs', 'security.md');
    const start = security.indexOf('\n## Egress\n');
    expect(start).toBeGreaterThan(-1);
    const first = security.slice(start).split(/\n\n/)[1];
    expect(first).toContain('infra/gcp');
  });

  it('names infra/gcp where the security notes lean on the allowlist', () => {
    const line = read('docs', 'security.md')
      .split('\n')
      .find((text) => text.includes('egress allowlist below'));
    expect(line, 'nothing mentions the egress allowlist below').toBeDefined();
    expect(line).toContain('infra/gcp');
  });
});

describe('what the GitHub App does', () => {
  // The docs once said nothing in OpenADLC merges and that the app was only an
  // OAuth client. The merge line merges as the app, and an operator who read
  // the old sentences could treat its private key as low-value plumbing, or
  // leave it unset and never see anything merge. Only these two files are read:
  // a spec fixture quotes the old sentence on purpose.
  // Whitespace is folded, because a sentence wraps wherever it falls.
  const read = (...path: string[]) => readFileSync(join(ROOT, ...path), 'utf8').replace(/\s+/g, ' ');

  it('does not say nothing merges', () => {
    expect(read('docs', 'self-hosting.md')).not.toContain('Nothing in OpenADLC merges anything');
  });

  it('does not call the app only an OAuth client', () => {
    const text = read('docs', 'platform-plan.md');
    expect(text).not.toContain('only an OAuth client');
    expect(text).not.toContain('never acts as `app[bot]`');
  });
});

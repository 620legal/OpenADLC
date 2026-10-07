#!/usr/bin/env node
/**
 * Reports a diff that goes beyond what its issues declared.
 *
 * Leaving the declared scope is not forbidden — some changes genuinely are
 * cross-cutting — but it should be a decision somebody made rather than
 * something that happened. So a pull request that leaves scope has to say so,
 * by carrying the `scope:cross-cutting` label, put on by someone other than
 * its author.
 *
 * The decision is `scopeCheck` in packages/shared/src/checks.ts, where it is
 * tested; this reads the diff and GitHub for it. A read of GitHub that fails
 * fails the check: it used to read as "declares nothing" and pass.
 *
 * Runs with the workflow's own read-only token and no secrets.
 */
import { execFileSync } from 'node:child_process';
import { acceptedIssueBody, CROSS_CUTTING_LABEL, scopeCheck } from '../../packages/shared/dist/index.js';

const base = process.env.BASE_SHA || 'origin/main';
const head = process.env.HEAD_SHA || 'HEAD';
const body = process.env.PR_BODY || '';
const labels = (process.env.PR_LABELS || '')
  .split(',')
  .map((label) => label.trim())
  .filter(Boolean);
const prNumber = Number(process.env.PR_NUMBER) || null;
const prAuthor = process.env.PR_AUTHOR || null;
const repo = process.env.GITHUB_REPOSITORY || '';
const token = process.env.GITHUB_TOKEN || '';

function changedFiles() {
  let out;
  try {
    out = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' });
  } catch {
    console.error(`scope-check: cannot read the diff ${base}...${head}; is the base branch fetched?`);
    process.exit(1);
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function github(path) {
  if (!token || !repo) {
    throw new Error(`GITHUB_TOKEN and GITHUB_REPOSITORY must both be set to read ${path}`);
  }
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}`);
  return response.json();
}

// The issue's body, who wrote and last edited it, its revisions, and who
// labelled it: what `acceptedIssueBody` needs to read a stranger's issue as it
// was when somebody with access took it up, not as its author edited it after.
const ISSUE_HISTORY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      body author { login } authorAssociation editor { login } lastEditedAt
      userContentEdits(first: 100) { nodes { editedAt editor { login } diff deletedAt } }
      timelineItems(itemTypes: [LABELED_EVENT], first: 100) { nodes { ... on LabeledEvent { createdAt actor { login } } } }
    }
  }
}`;

/** An issue as `scopeCheck` reads it, its body the one somebody with access accepted. */
async function readIssue(number) {
  const issue = await github(`/issues/${number}`);
  if (issue.pull_request) return issue;
  const [owner, name] = repo.split('/');
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: ISSUE_HISTORY, variables: { owner, name, number } }),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for #${number}'s history`);
  const answer = await response.json();
  const history = answer?.data?.repository?.issue;
  if (answer?.errors?.length || !history) {
    throw new Error(`GitHub would not give #${number}'s history: ${answer?.errors?.map((error) => error.message).join('; ') || 'no issue'}`);
  }
  const verdict = acceptedIssueBody({
    number,
    body: history.body || '',
    author: history.author?.login ?? null,
    authorAssociation: history.authorAssociation ?? null,
    editor: history.editor?.login ?? null,
    lastEditedAt: history.lastEditedAt ?? null,
    revisions: (history.userContentEdits?.nodes ?? []).filter(Boolean).map((edit) => ({
      editedAt: edit.editedAt,
      editor: edit.editor?.login ?? null,
      body: typeof edit.diff === 'string' ? edit.diff : null,
      deleted: Boolean(edit.deletedAt),
    })),
    labelled: (history.timelineItems?.nodes ?? []).filter((node) => node?.createdAt).map((node) => ({ at: node.createdAt, actor: node.actor?.login ?? null })),
  });
  // Never "declared no paths; skipping": that would let the author's edit through.
  if ('error' in verdict) throw new Error(verdict.error);
  if (verdict.body !== (history.body || '')) {
    console.log(`scope-check: #${number} was edited by its author after it was taken up; reading it as it was then`);
  }
  return { ...issue, body: verdict.body };
}

/** Who last put the label on, from the pull request's events, oldest first, a page at a time. */
async function crossCuttingBy() {
  if (!prNumber) return null;
  let by = null;
  for (let page = 1; page <= 10; page++) {
    const events = await github(`/issues/${prNumber}/events?per_page=100&page=${page}`);
    for (const event of events) {
      if (event.event === 'labeled' && event.label?.name === CROSS_CUTTING_LABEL) by = event.actor?.login ?? null;
    }
    if (events.length < 100) break;
  }
  return by;
}

const verdict = await scopeCheck({
  body,
  prNumber,
  prAuthor,
  labels,
  files: changedFiles(),
  readIssue,
  crossCuttingBy,
});

if (verdict.exit === 0) console.log(verdict.message);
else console.error(verdict.message);
process.exit(verdict.exit);

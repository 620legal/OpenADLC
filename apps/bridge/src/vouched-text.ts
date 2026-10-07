import { audit } from '@fleetadlc/db';
import { sameLogin } from '@fleetadlc/shared';

/**
 * Which title and body of a stranger's issue the crew reads.
 *
 * A person with access who labels a stranger's issue accepts it as it reads
 * then, and the bridge keeps that text (`issues.setVouched`). The author can
 * still edit it, and a person labelling it again later took whatever it said
 * by then, Expected paths and all, as the reconciler took a person's own edit
 * only once one of them acted again. What counts is who GitHub says wrote the
 * text now: an edit stands when its last editor (for the title, whoever last
 * renamed it) is not the author and OpenADLC acts for them. GitHub lets only
 * the author or someone with write access edit an issue, so a person accepts
 * a stranger's edit by editing the issue themselves.
 */

export interface IssueText {
  title: string;
  body: string;
}

/** GitHub's word on who last changed an issue's text (`GitHubClient.issueEdits`). */
export interface IssueEdits {
  author: string | null;
  editor: string | null;
  lastEditedAt: string | null;
  renamedBy: string | null;
}

export interface TextChoice extends IssueText {
  /** Whether anything of the live text was taken over what was kept. */
  changed: boolean;
  /** Whether the live text differs from what was kept in a part that was not taken. */
  refused: boolean;
  /** Who wrote what was taken: the editor, or whoever renamed it. */
  by: string | null;
  /** When the body was last edited, as GitHub says; what a refusal is said once for. */
  editedAt: string | null;
}

/**
 * The text to keep, given the text kept so far (`stored`) and GitHub's
 * (`live`). The live text when nothing is kept yet, when it is the same, or
 * when OpenADLC acts for the author; otherwise each of the title and the body
 * whose last change GitHub puts to somebody other than the author whom
 * OpenADLC acts for. GitHub is asked only when the texts differ, and when it
 * cannot be asked, the kept text stands.
 */
export async function chooseIssueText(input: {
  stored: IssueText | null;
  live: IssueText;
  /** Whether OpenADLC acts for the issue's author (`actsForOn`). */
  authorHeard: () => Promise<boolean>;
  /** Whether OpenADLC acts for this login on the repository (`actsForOn`). */
  heard: (login: string) => Promise<boolean>;
  /** GitHub's answer; rejects when GitHub cannot be asked. */
  edits: () => Promise<IssueEdits>;
}): Promise<TextChoice> {
  const { stored, live } = input;
  if (!stored || (stored.title === live.title && stored.body === live.body)) return { ...live, changed: false, refused: false, by: null, editedAt: null };
  if (await input.authorHeard().catch(() => false)) return { ...live, changed: true, refused: false, by: null, editedAt: null };

  const edits = await input.edits().catch(() => null);
  if (!edits) return { ...stored, changed: false, refused: true, by: null, editedAt: null };
  const author = edits.author;
  const byAnother = async (login: string | null): Promise<boolean> =>
    Boolean(login && author && !sameLogin(login, author)) && (await input.heard(login as string).catch(() => false));

  const bodyTaken = stored.body === live.body || (await byAnother(edits.editor));
  const titleTaken = stored.title === live.title || (await byAnother(edits.renamedBy));
  const changed = (bodyTaken && stored.body !== live.body) || (titleTaken && stored.title !== live.title);
  return {
    title: titleTaken ? live.title : stored.title,
    body: bodyTaken ? live.body : stored.body,
    changed,
    refused: !bodyTaken || !titleTaken,
    by: changed ? (bodyTaken && stored.body !== live.body ? edits.editor : edits.renamedBy) : null,
    editedAt: edits.lastEditedAt,
  };
}

/** Edits already said, by issue and when they were made; bounded, as a stream of them cannot grow it for good. */
const said = new Set<string>();
const SAID_KEPT = 1000;

/**
 * Says once, in the log and the audit log, that an issue's text on GitHub is
 * not what the crew reads, so the board's copy differing has a reason beside it.
 */
export async function editNotTaken(repoName: string, issueNumber: number, editedAt: string | null, where: string): Promise<void> {
  const key = `${repoName}#${issueNumber}@${editedAt ?? 'unknown'}`;
  if (said.has(key)) return;
  if (said.size >= SAID_KEPT) said.clear();
  said.add(key);
  console.log(
    `[bridge] ${repoName}#${issueNumber}: its text on GitHub changed after it was taken up, and not by anyone OpenADLC acts for as far as GitHub says; the crew reads it as it was accepted (${where})`,
  );
  await audit({
    actor: 'bridge',
    action: 'issue.edit_not_taken',
    target: `${repoName}#${issueNumber}`,
    payload: { editedAt, where },
  }).catch(() => undefined);
}

/** For tests: forget what was said. */
export function forgetSaidEdits(): void {
  said.clear();
}

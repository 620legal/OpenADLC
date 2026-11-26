/**
 * A Discover run: one read-only pass of the `discover` skill over a
 * repository's default-branch snapshot, which proposes new work through the
 * lenses switched on for it (#370,
 * docs/adr/0089-a-discover-run-is-an-intake-task-whose-proposals-hostd-checks-against-its-snapshot.md).
 *
 * The session says its proposals once, as its last message, in one
 * `discover_proposals` marker. hostd's runner reads it from the session's own
 * output, keeps only the `file:line` evidence that exists at the snapshot's
 * commit, and posts what is left to the bridge with the task's token; the
 * bridge runs the same checks again before it stores anything. Both read the
 * proposals through `checkProposals`, so what one keeps the other keeps.
 */
import { createHash } from 'node:crypto';
import { parseMarkers } from './markers.js';

export const DISCOVER_SKILL = 'discover';

/** The ways a run can look for work. `improve` ("Improve what you have") is the only one until the web lenses come (#370's issue 2). */
export const DISCOVER_LENSES = ['improve'] as const;
export type DiscoverLens = (typeof DISCOVER_LENSES)[number];

/** What a proposal says of the thing it proposes: not there, half there, or there already. */
export const DISCOVER_STATUSES = ['missing', 'partial', 'already there'] as const;
export type DiscoverStatus = (typeof DISCOVER_STATUSES)[number];

/** The most proposals one run stores; the rest are dropped and counted. */
export const MAX_DISCOVER_PROPOSALS = 30;
export const MAX_DISCOVER_KEY = 80;
export const MAX_DISCOVER_TITLE = 120;
export const MAX_DISCOVER_DESCRIPTION = 1000;
export const MAX_DISCOVER_EVIDENCE = 10;
export const MAX_DISCOVER_NOTE = 500;

/** A key is the model's kebab-case name for the thing, reused across runs so the fingerprint stays the same. */
const KEY = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Text that would open or close an HTML comment. The marker is one HTML
 * comment, and a field carrying `-->` ends it early wherever the message is
 * shown or posted; one carrying `<!--` reads as a marker of its own.
 */
const COMMENT_MARKUP = /<!--|-->/;

/** One line of code a proposal points at. */
export interface DiscoverEvidence {
  file: string;
  line: number;
}

export interface DiscoverProposal {
  lens: DiscoverLens;
  key: string;
  title: string;
  description: string;
  status: DiscoverStatus;
  evidence: DiscoverEvidence[];
}

/** What a run's proposals came to once checked: what is kept, how many were dropped, and the session's note. */
export interface DiscoverResult {
  proposals: DiscoverProposal[];
  dropped: number;
  note: string | null;
}

const RUN_SUBJECT = /^discover:([0-9a-f]{8})$/;

/** A run's task subject: `discover:` and the first eight of the run's id. */
export function discoverSubject(runId: string): string {
  return `discover:${runId.replace(/-/g, '').slice(0, 8).toLowerCase()}`;
}

/** The run prefix a `discover:` subject names, or null for any other subject. */
export function discoverRunPrefixOf(subjectRef: string): string | null {
  return RUN_SUBJECT.exec(subjectRef.trim())?.[1] ?? null;
}

/** What a later run recognises a proposal by: its lens and key, never its title or its lines, which drift. */
export function proposalFingerprint(lens: string, key: string): string {
  return createHash('sha256').update(`${lens}\n${key}`).digest('hex');
}

/**
 * One `path:line`, or `{file, line}`, as a line of evidence; null when it is
 * not one. A path is relative to the repository, with no `..` segment and no
 * leading `/`, and no control character; a line is 1 or more.
 */
export function evidenceFrom(raw: unknown): DiscoverEvidence | null {
  let file: unknown;
  let line: unknown;
  if (typeof raw === 'string') {
    const at = raw.lastIndexOf(':');
    if (at <= 0) return null;
    file = raw.slice(0, at).trim();
    const digits = raw.slice(at + 1).trim();
    line = /^\d+$/.test(digits) ? Number(digits) : NaN;
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    file = (raw as Record<string, unknown>).file;
    line = (raw as Record<string, unknown>).line;
  } else {
    return null;
  }
  if (typeof file !== 'string' || file.length === 0 || file.length > 300) return null;
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1) return null;
  if (file.startsWith('/') || /[\u0000-\u001f\u007f]/.test(file)) return null;
  const segments = file.replace(/\\/g, '/').split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) return null;
  return { file, line };
}

/** A trimmed string field between `min` and `max` characters with no comment markup, or null. */
function text(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length < 1 || value.length > max || COMMENT_MARKUP.test(value)) return null;
  return value;
}

function proposalFrom(raw: unknown): DiscoverProposal | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const lens = entry.lens;
  if (typeof lens !== 'string' || !(DISCOVER_LENSES as readonly string[]).includes(lens)) return null;
  const key = entry.key;
  if (typeof key !== 'string' || key.length > MAX_DISCOVER_KEY || !KEY.test(key)) return null;
  const title = text(entry.title, MAX_DISCOVER_TITLE);
  const description = text(entry.description, MAX_DISCOVER_DESCRIPTION);
  if (!title || !description) return null;
  const status = entry.status;
  if (typeof status !== 'string' || !(DISCOVER_STATUSES as readonly string[]).includes(status)) return null;
  if (!Array.isArray(entry.evidence) || entry.evidence.length < 1 || entry.evidence.length > MAX_DISCOVER_EVIDENCE) return null;
  const evidence: DiscoverEvidence[] = [];
  for (const one of entry.evidence) {
    const parsed = evidenceFrom(one);
    // A line it cannot point at is a claim with nothing behind it.
    if (!parsed) return null;
    if (!evidence.some((seen) => seen.file === parsed.file && seen.line === parsed.line)) evidence.push(parsed);
  }
  return { lens: lens as DiscoverLens, key, title, description, status: status as DiscoverStatus, evidence };
}

/**
 * The proposals a list holds that can be stored, and how many it dropped: one
 * that is not well formed, one past the 30th, and a second one with an earlier
 * one's fingerprint. A proposal with no evidence is not stored.
 */
export function checkProposals(list: readonly unknown[]): { proposals: DiscoverProposal[]; dropped: number } {
  const proposals: DiscoverProposal[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of list) {
    const proposal = proposalFrom(raw);
    const fingerprint = proposal ? proposalFingerprint(proposal.lens, proposal.key) : '';
    if (!proposal || seen.has(fingerprint) || proposals.length >= MAX_DISCOVER_PROPOSALS) {
      dropped += 1;
      continue;
    }
    seen.add(fingerprint);
    proposals.push(proposal);
  }
  return { proposals, dropped };
}

/** The session's note on its run, or null when it gave none it can keep. */
export function discoverNote(raw: unknown): string | null {
  return text(raw, MAX_DISCOVER_NOTE);
}

/**
 * The proposals a session's message carries: null when it has no
 * `discover_proposals` marker, `'malformed'` when the marker cannot be read or
 * its `proposals` is not a list, and otherwise what `checkProposals` keeps.
 * `[]` with a note is a run that found nothing worth proposing.
 */
export function parseDiscoverProposals(body: string): DiscoverResult | null | 'malformed' {
  const marker = parseMarkers(body).find((one) => one.event === 'discover_proposals');
  if (!marker) {
    // Said, but not JSON that parses: a marker cut short, or a field whose
    // `}` and `-->` closed the comment early.
    return /<!--\s*openadlc:[\s\S]*"discover_proposals"/.test(body) ? 'malformed' : null;
  }
  if (!Array.isArray(marker.proposals)) return 'malformed';
  const { proposals, dropped } = checkProposals(marker.proposals);
  return { proposals, dropped, note: discoverNote(marker.note) };
}

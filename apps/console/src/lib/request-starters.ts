/**
 * Examples the New request form offers while it is empty. A person new to the
 * crew wrote one line and intake asked for the rest a question at a time; a
 * starter shows the shape intake drafts an issue from, with `[blanks]` for
 * what only the person knows. They are built into the console, so they name
 * nothing in anyone's repository: a path here would be wrong everywhere else.
 *
 * Adding a starter is one entry. Each `text` is one line of at most 80
 * characters, so the request's title is the whole of it.
 */

export type StarterKind = 'feature' | 'defect' | 'chore';

export interface RequestStarter {
  /** The button's words, e.g. "A bug, with steps". */
  label: string;
  kind: StarterKind;
  /** Goes in "What do you want changed?". */
  text: string;
  /** Goes in Details. */
  details: string;
}

export const REQUEST_STARTERS: readonly RequestStarter[] = [
  {
    label: 'A bug, with steps',
    kind: 'defect',
    text: '[The page] shows [the wrong thing] when [I do something]',
    details:
      'Steps:\n1. Open [the page]\n2. [What you click or type]\n3. [What you do next]\n\n' +
      'What happened: [what you saw, or the error’s text]\n\n' +
      'What should have happened: [what you expected]',
  },
  {
    label: 'A small feature',
    kind: 'feature',
    text: '[Who] can [do something] on [the page]',
    details:
      'For: [who needs it, and why]\n\n' +
      'What it does: [a line or two]\n\n' +
      'Done when: [what a person can see or do once it ships]',
  },
  {
    label: 'A docs fix',
    kind: 'chore',
    text: 'Fix the docs on [the page]',
    details: 'Page: [the page, or its link]\n\nWrong text: "[what it says now]"\n\nShould say: [what is true]',
  },
  {
    label: 'Tests for a module',
    kind: 'chore',
    text: 'Add tests for [the module]',
    details:
      'Module: [the module]\n\n' +
      'Behaviours to cover:\n- [one behaviour]\n- [another behaviour]\n\n' +
      'Done when: each behaviour has a test that fails without it',
  },
];

/** The starters show only while both boxes are empty; whitespace counts as empty. */
export function showsStarters(text: string, details: string): boolean {
  return !text.trim() && !details.trim();
}

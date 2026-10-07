import { isFleetLogin } from './authorship.js';

/**
 * Who OpenADLC acts for: people with access to the repository, and its own crew.
 *
 * Anybody can open an issue, comment on one or open a pull request from a fork
 * on a public repository. OpenADLC read all of it as its own: an issue form's
 * `adlc:intake` label started intake on a stranger's issue, a stranger's
 * comment answered a bot's question and went into the next bot's prompt, and a
 * fork's branch named like a builder's was taken for the issue's pull request.
 * Each of those spends money and puts a stranger's words in front of a bot
 * that can write to the repository.
 *
 * GitHub says, on every issue, comment, review and pull request, how its author
 * is associated with the repository. An owner, a member of the owning
 * organization and a collaborator have access; a contributor from a fork, a
 * first-timer and anybody else do not. What they wrote stays on GitHub for a
 * person to read, and a person with access who acts on it — labels the issue,
 * answers in their own words — is who OpenADLC then acts for.
 */
export const WITH_ACCESS: readonly string[] = ['OWNER', 'MEMBER', 'COLLABORATOR'];

/** Whether an author's association with the repository gives them access. A missing one does not. */
export function hasAccess(association: string | null | undefined): boolean {
  return Boolean(association && WITH_ACCESS.includes(association.toUpperCase()));
}

/** An author OpenADLC acts for: one with access, or one of the crew by the account it goes by. */
export function actsFor(
  author: { login: string | null | undefined; association: string | null | undefined },
  crew: readonly { githubLogin: string | null }[],
): boolean {
  return hasAccess(author.association) || isFleetLogin(crew, author.login);
}

/**
 * What OpenADLC is called and where the public repository lives. One place,
 * so the GitHub App every install creates is named and links from here, an
 * install takes its releases from here unless told otherwise, and a fork
 * changes them in one file. `package.json` carries the address too, for npm's
 * sake, and infra/gcp's `release_repository` its default, since Terraform reads
 * no TypeScript; a test holds each equal to this.
 */
export const PROJECT_NAME = 'OpenADLC';
/** The public repository as owner/name: where releases come from unless an install names another. */
export const PROJECT_REPOSITORY = '620legal/OpenADLC';
export const PROJECT_URL = `https://github.com/${PROJECT_REPOSITORY}`;

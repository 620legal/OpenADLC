/**
 * What a person may attach, as the console says it before anything is sent.
 *
 * The rule is the bridge's (`checkAttachment` in `@fleetadlc/shared`), which
 * reads the bytes and has the last word; the console does not depend on that
 * package (see `stages.ts`), so the limits are copied here and
 * `attachments.test.ts` fails when the two differ. What is checked here is only
 * what can be known without reading the file: its size and its name, so a
 * person hears at once that a 40 MB video will not go, rather than after it
 * has uploaded.
 */

export const FILE_LIMIT_BYTES = 10 * 1024 * 1024;
export const ITEM_FILES = 20;
export const ITEM_BYTES = 25 * 1024 * 1024;

/** What the picker offers, by extension and type. */
export const ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.json,image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,application/json';

const TAKEN = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'md', 'markdown', 'csv', 'json']);

/** The line the dialog and the box say about where files go. */
export const WHERE_FILES_GO = 'Files are kept in OpenADLC and given to the crew’s models. They are never posted to GitHub.';

export function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/**
 * A refused file's size, rounded up to a tenth: `megabytes` rounds a file just
 * over the limit down to the limit, and "is 10 MB; a file can be 10 MB at most"
 * reads as a contradiction.
 */
function sizeOver(bytes: number): string {
  return `${Math.ceil((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/** Why a file cannot be attached, naming it, or null when it may be tried. */
export function refusalFor(file: { name: string; size: number }, already: { count: number; bytes: number }): string | null {
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? '';
  if (['svg', 'html', 'htm'].includes(extension)) return `${file.name} can carry script, so it is not taken; attach a PNG or a PDF of it instead`;
  if (extension && !TAKEN.has(extension)) return `${file.name} is not a type OpenADLC takes: images (PNG, JPEG, GIF, WebP), PDFs, and .txt, .md, .csv or .json`;
  if (file.size === 0) return `${file.name} is empty`;
  if (file.size > FILE_LIMIT_BYTES) return `${file.name} is ${sizeOver(file.size)}; a file can be ${megabytes(FILE_LIMIT_BYTES)} at most`;
  if (already.count + 1 > ITEM_FILES) return `adding ${file.name} would make more than ${ITEM_FILES} files; a work item can carry ${ITEM_FILES}`;
  if (already.bytes + file.size > ITEM_BYTES) return `${file.name} would take these files past ${megabytes(ITEM_BYTES)} together`;
  return null;
}

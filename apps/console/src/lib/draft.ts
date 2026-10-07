import { useCallback, useEffect, useState } from 'react';

/**
 * Something typed and not yet sent, kept in the tab's session storage.
 *
 * The page reads itself again every fifteen seconds, and when the console was
 * restarted or updated under an open tab that read fails and Next loads the
 * page afresh: a request or a message being written was gone without a word.
 * Kept here, it is put back when the page is drawn again, and dropped once it
 * is sent.
 */
const PREFIX = 'fleetadlc:draft:';

export function readDraft(key: string): string {
  try {
    return window.sessionStorage.getItem(PREFIX + key) ?? '';
  } catch {
    // Storage refused (a private window, or blocked): the draft lives only on screen.
    return '';
  }
}

export function writeDraft(key: string, text: string): void {
  try {
    if (text) window.sessionStorage.setItem(PREFIX + key, text);
    else window.sessionStorage.removeItem(PREFIX + key);
  } catch {
    // As above.
  }
}

/**
 * `useState('')` that outlives a reload. It starts empty, as the server drew
 * it, and takes the kept draft once in the browser.
 */
export function useDraft(key: string): [string, (text: string) => void] {
  const [text, setText] = useState('');
  useEffect(() => {
    setText(readDraft(key));
  }, [key]);
  const set = useCallback(
    (next: string) => {
      setText(next);
      writeDraft(key, next);
    },
    [key],
  );
  return [text, set];
}

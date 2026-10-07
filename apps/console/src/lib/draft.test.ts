// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDraft, writeDraft } from './draft';

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe('a draft kept in the tab', () => {
  it('is read back until it is emptied', () => {
    writeDraft('intake:text', 'A hello world page');
    expect(readDraft('intake:text')).toBe('A hello world page');
    expect(readDraft('intake:context')).toBe('');
    writeDraft('intake:text', '');
    expect(readDraft('intake:text')).toBe('');
    expect(window.sessionStorage.length).toBe(0);
  });

  it('lives only on screen when storage is refused', () => {
    // A private window, or site data blocked: even reaching the storage throws.
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => writeDraft('intake:text', 'kept on screen')).not.toThrow();
    expect(readDraft('intake:text')).toBe('');
  });
});

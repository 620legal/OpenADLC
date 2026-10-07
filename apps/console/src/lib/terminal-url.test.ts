import { describe, expect, it } from 'vitest';
import { socketFailure, terminalBase } from './terminal-url';

/**
 * A cloud console was built without NEXT_PUBLIC_FLEETADLC_TERMINAL_URL and
 * started with it, so take-over dialled port 47312 on its own domain, where
 * nothing listens. The address the console runs with comes first now.
 */

const PAGE = { protocol: 'https:', hostname: 'console.example.com' };

describe('where take-over connects', () => {
  it('uses the address the console runs with, over an empty one it was built with', () => {
    expect(terminalBase('wss://console.example.com', '', PAGE)).toBe('wss://console.example.com');
    expect(terminalBase('wss://console.example.com', 'ws://127.0.0.1:47312', PAGE)).toBe('wss://console.example.com');
  });

  it('falls back to the address it was built with', () => {
    expect(terminalBase(undefined, 'ws://127.0.0.1:47399', PAGE)).toBe('ws://127.0.0.1:47399');
  });

  it('falls back to port 47312 on the page’s host, secure when the page is', () => {
    expect(terminalBase(undefined, '', PAGE)).toBe('wss://console.example.com:47312');
    expect(terminalBase(null, undefined, { protocol: 'http:', hostname: '127.0.0.1' })).toBe('ws://127.0.0.1:47312');
  });
});

describe('a socket that never opened', () => {
  it('names the address it tried, and where that address comes from', () => {
    const said = socketFailure('wss://console.example.com:47312/terminal', 'https://console.example.com');
    expect(said).toContain('wss://console.example.com:47312/terminal');
    expect(said).toContain('NEXT_PUBLIC_FLEETADLC_TERMINAL_URL when the console is started with one');
    expect(said).toContain('FLEETADLC_CONSOLE_URL');
  });
});

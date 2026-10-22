import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { promptSecret, type SecretTerminal } from './ui.js';

/**
 * A terminal as `promptSecret` sees one: a TTY stdin whose raw mode is
 * recorded, and a screen that keeps every byte written to it, in order with
 * the mode changes.
 */
function fakeTerminal(options: { tty?: boolean } = {}) {
  const tty = options.tty ?? true;
  const events: string[] = [];
  let screen = '';
  let interrupts = 0;
  const input = new PassThrough() as PassThrough & SecretTerminal['input'];
  if (tty) {
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (mode: boolean) => {
      input.isRaw = mode;
      events.push(`raw ${mode}`);
    };
  }
  const terminal: SecretTerminal = {
    input,
    output: {
      write(text: string) {
        screen += text;
        events.push(`write ${JSON.stringify(text)}`);
        return true;
      },
    },
    interrupted() {
      interrupts += 1;
      events.push(`interrupted, raw ${input.isRaw}`);
    },
  };
  return {
    terminal,
    input,
    events,
    screen: () => screen,
    interrupts: () => interrupts,
    /** Until the question is up, which is when a person starts typing. */
    asked: async () => {
      while (!screen.endsWith(': ')) await new Promise((resolve) => setImmediate(resolve));
    },
    /** Typed the way a terminal delivers keys: each argument is one read. */
    type: (...reads: string[]) => {
      for (const read of reads) input.write(read);
    },
  };
}


describe('promptSecret', () => {
  it('puts nothing typed on the screen, and the terminal back as it was', async () => {
    const term = fakeTerminal();
    const answer = promptSecret('Passphrase', term.terminal);
    await term.asked();
    // One key per read as typed, and a paste in a single read.
    term.type('T', 'O', 'P', 'SECRET', 'V', 'A', 'L', 'U', 'E', '\r');

    expect(await answer).toBe('TOPSECRETVALUE');
    // The whole screen, so a single echoed character, a mask or a cursor move
    // fails it, not only the full value.
    expect(term.screen()).toBe('  Passphrase: \n');
    // Raw before the question: a key typed once it is up would otherwise be
    // echoed by the terminal itself.
    expect(term.events).toEqual(['raw true', 'write "  Passphrase: "', 'raw false', 'write "\\n"']);
    expect(term.input.isRaw).toBe(false);
  });

  it('edits the way a line does, without showing any of it', async () => {
    const term = fakeTerminal();
    const answer = promptSecret('Passphrase', term.terminal);
    await term.asked();
    // A typo taken back, a line started again with Ctrl-U, an arrow key that
    // must not become "[D" in the passphrase, and a key that is not ASCII.
    term.type('wrong', '\u0015', 'pä', 'X', '\u007f', '\b', 'ä', '\u001b[D', 'ss🔑', '\t', '\r');

    expect(await answer).toBe('päss🔑');
    expect(term.screen()).toBe('  Passphrase: \n');
  });

  it('on Ctrl-C, puts the terminal back before it stops', async () => {
    const term = fakeTerminal();
    const answer = promptSecret('Passphrase', term.terminal);
    await term.asked();
    term.type('half a sec', '\u0003');

    await expect(answer).rejects.toThrow('interrupted');
    expect(term.interrupts()).toBe(1);
    expect(term.events.at(-1)).toBe('interrupted, raw false');
    expect(term.screen()).toBe('  Passphrase: \n');
  });

  it('keeps nothing typed after Enter in the same read for the next question', async () => {
    const term = fakeTerminal();
    const first = promptSecret('Passphrase', term.terminal);
    await term.asked();
    term.type('first\rpasted too\r');
    expect(await first).toBe('first');

    const second = promptSecret('Passphrase again', term.terminal);
    await term.asked();
    term.type('second\r');

    expect(await second).toBe('second');
    expect(term.screen()).toBe('  Passphrase: \n  Passphrase again: \n');
  });

  it('takes a CRLF as one Enter', async () => {
    const term = fakeTerminal();
    const answer = promptSecret('Passphrase', term.terminal);
    await term.asked();
    term.type('pasted\r\n');

    expect(await answer).toBe('pasted');
  });

  it('says so when the terminal closes before Enter, with raw mode off', async () => {
    const term = fakeTerminal();
    const answer = promptSecret('Passphrase', term.terminal);
    await term.asked();
    term.type('never fini');
    term.input.end();

    await expect(answer).rejects.toThrow('the terminal closed before an answer was given');
    expect(term.input.isRaw).toBe(false);
    expect(term.screen()).toBe('  Passphrase: \n');
  });

  it('reads a pipe as a line, which has no echo to suppress', async () => {
    const term = fakeTerminal({ tty: false });
    const answer = promptSecret('Passphrase', term.terminal);
    await term.asked();
    term.type('from a pipe\n');

    expect(await answer).toBe('from a pipe');
    expect(term.screen()).toBe('  Passphrase: \n');
    expect(term.events.some((event) => event.startsWith('raw'))).toBe(false);
  });

  it('reads the last line of a pipe that has no newline', async () => {
    const term = fakeTerminal({ tty: false });
    const answer = promptSecret('Passphrase', term.terminal);
    await term.asked();
    term.input.end('no newline');

    expect(await answer).toBe('no newline');
  });

  it('says so when a pipe ends with nothing in it', async () => {
    const term = fakeTerminal({ tty: false });
    const answer = promptSecret('Passphrase', term.terminal);
    await term.asked();
    term.input.end();

    await expect(answer).rejects.toThrow('stdin ended before an answer was given');
  });
});

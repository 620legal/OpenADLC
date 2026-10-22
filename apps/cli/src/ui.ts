const supportsColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

function paint(code: string, text: string): string {
  return supportsColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const ui = {
  heading: (text: string) => console.log(`\n${paint('1', text)}`),
  step: (text: string) => console.log(`  ${paint('36', '›')} ${text}`),
  ok: (text: string) => console.log(`  ${paint('32', '✓')} ${text}`),
  warn: (text: string) => console.log(`  ${paint('33', '!')} ${text}`),
  fail: (text: string) => console.log(`  ${paint('31', '✗')} ${text}`),
  note: (text: string) => console.log(`    ${paint('90', text)}`),
  plain: (text = '') => console.log(text),
  code: (text: string) => console.log(`    ${paint('36', text)}`),
  /** The device-flow user code is the one thing a person must read and type. */
  bigCode: (text: string) => console.log(`\n    ${paint('1;33', text)}\n`),
};

export async function prompt(question: string, fallback = ''): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`  ${question}${fallback ? ` (${fallback})` : ''}: `);
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}

export async function confirm(question: string): Promise<boolean> {
  const answer = await prompt(`${question} [y/N]`);
  return /^y(es)?$/i.test(answer);
}

/** What `promptSecret` reads, writes, and does on Ctrl-C: the process's own, but in its tests. */
export interface SecretTerminal {
  input: NodeJS.ReadableStream & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => unknown };
  output: { write(text: string): unknown };
  /** Ctrl-C, once the terminal is back as it was. */
  interrupted(): void;
}

function processTerminal(): SecretTerminal {
  // 130 is what a shell reports for a command Ctrl-C stopped, which is what a
  // Ctrl-C here would have done had raw mode not taken it from the terminal.
  return { input: process.stdin, output: process.stdout, interrupted: () => process.exit(130) };
}

/** What node:readline's keypress events say about a key. */
interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
}

/**
 * Reads a line without a character of it reaching the screen: every question
 * the CLI asks for a secret goes through this, and `prompt`, which echoes,
 * never does.
 *
 * At a terminal the keys are read in raw mode, where the terminal echoes
 * nothing, and nothing is written for them either. readline cannot be told not
 * to echo: `openadlc backup` used to replace its `_writeToOutput` once the
 * question was up, but readline writes the line through an internal method of
 * its own, so the replacement never ran and the passphrase appeared as it was
 * typed (`Secret: ^[[11GTOPSECRETVALUE`, #99). Only readline's key parser is
 * used here, so arrow keys and the like are keys, not text in the passphrase.
 *
 * Raw mode goes on before the question is written: a key that arrives while
 * the terminal is still cooked is echoed by the terminal itself, and the
 * question is the signal to start typing. Whatever came in the same read after
 * Enter is dropped rather than kept for the next question, which may be one
 * that echoes, and what is pasted with a secret is likely more of it.
 *
 * A pipe has no echo to suppress, so it is read as a line.
 */
export async function promptSecret(question: string, terminal: SecretTerminal = processTerminal()): Promise<string> {
  const { input, output } = terminal;
  const { createInterface, emitKeypressEvents } = await import('node:readline');
  if (!input.isTTY || !input.setRawMode) {
    output.write(`  ${question}: `);
    const rl = createInterface({ input, terminal: false });
    try {
      return await new Promise<string>((resolve, reject) => {
        // 'line', not `question`: readline hands the last line of a pipe that
        // has no newline to 'line' alone, and closes in the same tick.
        rl.once('line', resolve);
        rl.once('close', () => reject(new Error('stdin ended before an answer was given')));
      });
    } finally {
      rl.close();
      output.write('\n');
    }
  }

  const setRawMode = input.setRawMode.bind(input);
  const wasRaw = input.isRaw === true;
  emitKeypressEvents(input);
  setRawMode(true);
  output.write(`  ${question}: `);

  return new Promise<string>((resolve, reject) => {
    const typed: string[] = [];
    const putBack = () => {
      input.removeListener('keypress', onKey);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      input.pause();
      setRawMode(wasRaw);
      // The question's line ends here: the Enter that ended it was not echoed.
      output.write('\n');
    };
    const onKey = (text: string | undefined, key: Key = {}) => {
      if (key.ctrl && key.name === 'c') {
        putBack();
        terminal.interrupted();
        reject(new Error('interrupted'));
      } else if (key.name === 'return' || key.name === 'enter') {
        putBack();
        resolve(typed.join(''));
      } else if (key.name === 'backspace') {
        typed.pop();
      } else if (key.ctrl && key.name === 'u') {
        typed.length = 0;
      } else if (text !== undefined && !key.ctrl && !key.meta && text >= ' ') {
        // `text` is undefined for an escape sequence such as an arrow key, and
        // one whole code point for anything else; below a space is a control.
        typed.push(text);
      }
    };
    const onEnd = () => {
      putBack();
      reject(new Error('the terminal closed before an answer was given'));
    };
    const onError = (error: unknown) => {
      putBack();
      reject(error);
    };
    input.on('keypress', onKey);
    input.once('end', onEnd);
    input.once('error', onError);
    input.resume();
  });
}

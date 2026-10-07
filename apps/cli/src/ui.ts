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

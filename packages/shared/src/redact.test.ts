import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { redactSecrets, secretKind } from './redact.js';

/** Token-shaped, put together here so no secret scanner reads one in the source. */
const token = (prefix: string, body: string): string => `${prefix}_${body}`;

/** A PEM header or footer line, put together for the same reason. */
const edge = (word: string): string => `-----${word} RSA PRIVATE KEY-----`;

/**
 * `redactSecrets` of each text, run in a worker that is ended after `ms`, or
 * `'hung'`. A loop that never ends cannot fail a test from inside it: the
 * test runner waits on it for ever.
 */
async function redactInWorker(texts: string[], ms: number): Promise<string[] | 'hung'> {
  const source = readFileSync(new URL('./redact.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const worker = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads');
     const exports = {};
     (function (exports) { ${code} })(exports);
     parentPort.postMessage(workerData.map((text) => exports.redactSecrets(text)));`,
    { eval: true, workerData: texts },
  );
  try {
    return await new Promise<string[] | 'hung'>((resolve, reject) => {
      const timer = setTimeout(() => resolve('hung'), ms);
      worker.once('message', (out: string[]) => {
        clearTimeout(timer);
        resolve(out);
      });
      worker.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } finally {
    await worker.terminate();
  }
}

describe('credentials in text meant for a person', () => {
  it('are taken out of a git remote in a failed command', () => {
    const said =
      `Command failed: git fetch --prune https://x-access-token:${token('ghu', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')}@github.com/exampleco/fleetadlc.git`;
    expect(redactSecrets(said)).toBe('Command failed: git fetch --prune https://x-access-token:***@github.com/exampleco/fleetadlc.git');
  });

  it('are taken out wherever a GitHub token appears on its own', () => {
    expect(redactSecrets(`token ${token('ghs', '0123456789abcdefghijABCDEFGHIJ')} was refused`)).toBe('token ghs_*** was refused');
    expect(redactSecrets('github_pat_11AAAAAAA0123456789_abcdefghijklmnop')).toBe('github_pat_***');
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('fatal: invalid reference: refs/heads/agent/builder/66-issue-66')).toBe(
      'fatal: invalid reference: refs/heads/agent/builder/66-issue-66',
    );
    expect(redactSecrets('the task-runner exited')).toBe('the task-runner exited');
    expect(redactSecrets('see sk-short-word here')).toBe('see sk-short-word here');
  });
});

describe('credentials other than GitHub’s', () => {
  const key = (prefix: string): string => `${prefix}${'Ab3_'.repeat(10)}`;

  it('masks an Anthropic API key', () => {
    expect(redactSecrets(`ANTHROPIC_API_KEY=${key('sk-ant-api03-')}`)).toBe('ANTHROPIC_API_KEY=sk-ant-***');
  });

  it('masks an Anthropic setup token', () => {
    expect(redactSecrets(`token ${key('sk-ant-oat01-')} expired`)).toBe('token sk-ant-*** expired');
  });

  it('masks an OpenAI project key', () => {
    expect(redactSecrets(`OPENAI_API_KEY=${key('sk-proj-')}`)).toBe('OPENAI_API_KEY=sk-proj-***');
  });

  it('masks a plain sk- key of 20 characters or more', () => {
    expect(redactSecrets('key sk-abcdefghijklmnopq0 refused')).toBe('key sk-*** refused');
  });

  it('masks an xAI key', () => {
    expect(redactSecrets(`XAI_API_KEY=${key('xai-')}`)).toBe('XAI_API_KEY=xai-***');
  });

  it('masks a JWT', () => {
    const jwt = ['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXNpZw'].join('.');
    expect(redactSecrets(`id_token=${jwt}`)).toBe('id_token=eyJ***');
  });

  it('masks a JWT whose payload is longer than 4096 characters', () => {
    const jwt = ['eyJhbGciOiJSUzI1NiJ9', 'e'.repeat(5000), 'c2lnbmF0dXJlLXNpZw'].join('.');
    expect(redactSecrets(`token ${jwt}`)).toBe('token eyJ***');
    expect(secretKind(jwt)).toBe('a JWT');
  });

  it('masks a JWT that follows a hyphen', () => {
    const jwt = ['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXNpZw'].join('.');
    expect(redactSecrets(`token-${jwt}`)).toBe('token-eyJ***');
    expect(redactSecrets(`id_token=${jwt}-next`)).toBe('id_token=eyJ***');
    expect(secretKind(`-${jwt}`)).toBe('a JWT');
    expect(redactSecrets(`they${jwt}`)).toBe(`they${jwt}`);
  });

  it('masks a bearer token', () => {
    expect(redactSecrets('Authorization: Bearer abcdefgh12345678==')).toBe('Authorization: Bearer ***');
  });

  it('masks an OpenSSH private key block', () => {
    const block = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU=', '-----END OPENSSH PRIVATE KEY-----'].join('\n');
    expect(redactSecrets(`key:\n${block}\ndone`)).toBe('key:\n-----BEGIN OPENSSH PRIVATE KEY-----***\ndone');
  });

  it('masks an RSA private key block', () => {
    const block = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn', '-----END RSA PRIVATE KEY-----'].join('\n');
    expect(redactSecrets(block)).toBe('-----BEGIN RSA PRIVATE KEY-----***');
  });

  it('masks a password in a URL of any scheme', () => {
    expect(redactSecrets('could not reach postgres://user:secret@host/db')).toBe('could not reach postgres://user:***@host/db');
    const password = 'p'.repeat(600);
    expect(secretKind(`postgres://user:${password}@host/db`)).toBe('a password in a URL');
    expect(redactSecrets(`postgres://user:${password}@host/db`)).toBe('postgres://user:***@host/db');
    expect(redactSecrets(`postgres://user:${'p'.repeat(5000)}@host/db`)).toBe('postgres://user:***@host/db');
    // `//` is not a scheme. Stopping the password there left it in the log.
    expect(redactSecrets('postgres://u:ab//cd@h/db')).toBe('postgres://u:***@h/db');
    // A 256-character cap on the user left this in the log.
    const user = 'u'.repeat(300);
    expect(redactSecrets(`https://${user}:pw@h`)).toBe(`https://${user}:***@h`);
    // `://` inside the password, and dashes, are still the password.
    expect(redactSecrets('https://u:http://x@h')).toBe('https://u:***@h');
    expect(redactSecrets('https://u:ab-----cd@h')).toBe('https://u:***@h');
    // A digit or a mark before the scheme, or a scheme longer than 32
    // characters, still has a scheme at the end.
    expect(redactSecrets('1https://u:pw@h')).toBe('1https://u:***@h');
    expect(redactSecrets('-https://u:pw@h')).toBe('-https://u:***@h');
    expect(redactSecrets(`${'a'.repeat(40)}://u:pw@h`)).toBe(`${'a'.repeat(8)}${'a'.repeat(32)}://u:***@h`);
  });

  it('does not overflow on a long password with no @, or on a 9 MB key body', () => {
    const started = performance.now();
    expect(secretKind(`a://x:${'p'.repeat(2_000_000)}`)).toBeNull();
    const body = 'A'.repeat(9 * 1024 * 1024);
    const key = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
    expect(redactSecrets(key)).toBe('-----BEGIN PRIVATE KEY-----***');
    expect(secretKind(`-----BEGIN PRIVATE KEY-----\n${body}\n`)).toBeNull();
    // `a:` is a password character. A group per colon overflowed on 8 MB of it.
    expect(() => secretKind(`a://x:${'a:'.repeat(8 * 1024 * 1024)}`)).not.toThrow();
    expect(secretKind(`a://x:${'a:'.repeat(8 * 1024 * 1024)}`)).toBeNull();
    // `-a` is a key body. Stopping at `-` and retrying overflowed on 9 MB of it,
    // and an embedded block or a second header is still the same key.
    const dashed = `-a`.repeat(9 * 1024 * 1024);
    expect(redactSecrets(`-----BEGIN PRIVATE KEY-----\n${dashed}\n-----END PRIVATE KEY-----`)).toBe('-----BEGIN PRIVATE KEY-----***');
    const nested = [
      '-----BEGIN PRIVATE KEY-----',
      '-----BEGIN CERTIFICATE-----',
      'AAAA',
      '-----END CERTIFICATE-----',
      '------END PRIVATE KEY-----',
    ].join('\n');
    expect(redactSecrets(`before\n${nested}\nafter`)).toBe('before\n-----BEGIN PRIVATE KEY-----***\nafter');
    const repeated = ['-----BEGIN PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----', 'MIIE', '-----END PRIVATE KEY-----'].join('\n');
    expect(redactSecrets(repeated)).toBe('-----BEGIN PRIVATE KEY-----***');
    // Five dashes inside a body line are body, not the END line.
    expect(redactSecrets([edge('BEGIN'), 'ab-----cd', edge('END')].join('\n'))).toBe(`${edge('BEGIN')}***`);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('returns when the text ends at a private key header or at `-----END `', async () => {
    // The walk past each END that is not a footer ran off the end of the
    // text and started again at the same header, so this never came back,
    // and hostd redacts each pane line: `cat id_rsa` would hang it.
    const texts = [
      edge('BEGIN'),
      `${edge('BEGIN')}\n-----END `,
      `${edge('BEGIN')}\nMIIE\n-----END `,
      `${edge('BEGIN')}\nMIIE\n${edge('END')}\n${edge('BEGIN')}`,
      ['-----BEGIN PRIVATE KEY-----', 'MIIE', '-----END PRIVATE KEY-----', edge('BEGIN')].join('\n'),
    ];
    expect(await redactInWorker(texts, 5000)).toEqual([
      texts[0],
      texts[1],
      texts[2],
      `${edge('BEGIN')}***\n${edge('BEGIN')}`,
      `-----BEGIN PRIVATE KEY-----***\n${edge('BEGIN')}`,
    ]);
    expect(texts.map((text) => secretKind(text))).toEqual([null, null, null, 'a private key', 'a private key']);
  });

  it('masks a private key written with JSON escapes, encryption headers, or YAML indentation', () => {
    const json = '{"private_key":"-----BEGIN PRIVATE KEY-----\\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn\\n-----END PRIVATE KEY-----\\n"}';
    expect(secretKind(json)).toBe('a private key');
    expect(redactSecrets(json)).toBe('{"private_key":"-----BEGIN PRIVATE KEY-----***\\n"}');
    const encrypted = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'Proc-Type: 4,ENCRYPTED',
      'DEK-Info: AES-256-CBC,0123456789ABCDEF',
      '',
      'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    expect(secretKind(encrypted)).toBe('a private key');
    expect(redactSecrets(encrypted)).toBe('-----BEGIN RSA PRIVATE KEY-----***');
    const yaml = [
      'key:',
      '  -----BEGIN OPENSSH PRIVATE KEY-----',
      '  b3BlbnNzaC1rZXktdjEAAAAABG5vbmU=',
      '  -----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    expect(secretKind(yaml)).toBe('a private key');
    expect(redactSecrets(yaml)).toBe('key:\n  -----BEGIN OPENSSH PRIVATE KEY-----***');
  });

  it('reads a long line in time proportional to its length', () => {
    const started = performance.now();
    redactSecrets('a'.repeat(64 * 1024));
    redactSecrets('a.'.repeat(32 * 1024));
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('reads a megabyte made to be slow in well under a second', () => {
    // Each of these used to scan the rest of the text from every starting
    // point: `-eyJ` for the JWT, `a://x:` for a URL password, and a BEGIN
    // line with no END for a private key. A 1 MB upload then froze the bridge.
    const started = performance.now();
    expect(secretKind('-eyJ'.repeat(250_000))).toBeNull();
    expect(secretKind('a://x:'.repeat(40_000))).toBeNull();
    expect(secretKind('-----BEGIN PRIVATE KEY-----\n'.repeat(20_000))).toBeNull();
    // A dot after that run is a real token. Restarting the scan at every
    // `-eyJ` used to reread the whole line for each one.
    expect(secretKind(`${'-eyJ'.repeat(250_000)}.${'a'.repeat(8)}.${'b'.repeat(8)}`)).toBe('a JWT');
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('names what it found', () => {
    expect(secretKind(`k=${key('sk-ant-api03-')}`)).toBe('an Anthropic key');
    expect(secretKind('postgres://user:secret@host/db')).toBe('a password in a URL');
    expect(secretKind('nothing here')).toBeNull();
  });
});

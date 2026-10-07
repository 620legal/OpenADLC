#!/usr/bin/env node
/**
 * Checks take-over for real: mint a token, open the socket, type a command into
 * the bot's session, read the output back, detach, and confirm the session is
 * still alive and every step is in the audit log.
 *
 *   tests/scratch.sh up && eval "$(tests/scratch.sh env)" && node tests/terminal.mjs
 */
import { closePool, listAudit, query, waitForDatabase } from '@fleetadlc/db';
import { getSecretStore, internalSecretRef } from '@fleetadlc/github';
import WebSocket from 'ws';
import { refuseARealInstall } from './scratch-only.mjs';

// Before anything else is read or written: see scratch-only.mjs.
await refuseARealInstall();

const HOSTD = process.env.FLEETADLC_HOSTD_URL ?? 'http://127.0.0.1:47312';
const WS = HOSTD.replace(/^http/, 'ws');
/**
 * The bot to take over: the builder, found by its role, since its name is its
 * account's handle once one is connected. `FLEETADLC_TERMINAL_BOT` names another.
 */
let BOT = process.env.FLEETADLC_TERMINAL_BOT ?? '';
const IDENTITY = 'terminal test';

// hostd refuses a caller without the install's secret, so the suite holds it the
// way the bridge and `fleetadlc attach` do: by reading the secret store.
const SECRET = await getSecretStore().get(internalSecretRef());

function authHeaders(onBehalfOf) {
  return {
    'content-type': 'application/json',
    'x-fleetadlc-internal-secret': SECRET ?? '',
    ...(onBehalfOf ? { 'x-fleetadlc-on-behalf-of': onBehalfOf } : {}),
  };
}

const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

async function mintToken(session, identity) {
  const response = await fetch(`${HOSTD}/terminal/tokens`, {
    method: 'POST',
    headers: authHeaders(identity),
    body: JSON.stringify({ bot: BOT, session }),
  });
  return response.json();
}

function connect(token, options = {}) {
  return new Promise((resolve, reject) => {
    // The token is the subprotocol. A query string is the request line, which
    // is what a proxy writes down, so `?token=` is not a way in.
    const url = options.query ? `${WS}/terminal?token=${encodeURIComponent(token)}` : `${WS}/terminal`;
    const protocols = options.query ? [] : [`fleetadlc-attach.${token}`];
    const ws = new WebSocket(url, protocols, { handshakeTimeout: 10_000 });
    const timer = setTimeout(() => reject(new Error('the socket did not open')), 10_000);
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    ws.on('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', fail);
    ws.on('unexpected-response', () => fail(new Error('the handshake was refused')));
  });
}

/**
 * Collects everything the socket sends from the moment it opens, so a check
 * never misses output that arrived before it started looking.
 */
function collect(ws) {
  const state = { buffer: '' };
  ws.on('message', (chunk) => {
    state.buffer += chunk.toString();
  });

  state.waitFor = (pattern, timeoutMs = 10_000) =>
    new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const poll = setInterval(() => {
        if (pattern.test(state.buffer)) {
          clearInterval(poll);
          resolve(state.buffer);
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          resolve(null);
        }
      }, 100);
    });

  return state;
}

/**
 * The lines a terminal's output puts on screen, near enough to compare text:
 * a cursor move to another row starts a new line, and every other control
 * sequence (colours, erase-to-end-of-line, modes) is dropped.
 */
function screenLines(buffer) {
  return buffer
    .replace(/\x1b\[[0-9;]*[Hf]/g, '\n')
    .replace(/\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b[=>78]/g, '')
    .split(/\r?\n|\r/);
}

/**
 * The newest audit row now. The checks read only rows written after it: audit
 * rows outlive a run that failed partway, and a check that read the latest
 * matching row passed on the last run's.
 */
async function auditMark() {
  const rows = await query('select coalesce(max(id), 0) as id from audit');
  return Number(rows[0]?.id ?? 0);
}

async function main() {
  await waitForDatabase();
  if (!BOT) {
    const [builder] = await query("select name from bots where role = 'implement' order by slot limit 1");
    BOT = builder?.name ?? 'builder';
  }

  const sessionList = await fetch(`${HOSTD}/bots/${BOT}/sessions`, { headers: authHeaders() }).then(
    (response) => response.json(),
  );
  const sessions = sessionList.sessions ?? [];
  // Prefer the bot's idle shell: a task session may end mid-check, and what is
  // being tested is take-over, not the lifetime of one task.
  const session = (sessions.find((entry) => entry.name === 'shell') ?? sessions[0])?.name;
  if (!session) {
    throw new Error(`${BOT} has no session to attach to; is hostd running?`);
  }

  console.log(`\nterminal checks against ${BOT}/${session}\n`);
  const before = await auditMark();

  // 1. A token is minted for one bot and one session.
  const minted = await mintToken(session, 'terminal test');
  check('mints an attach token', Boolean(minted.token), `valid ${minted.expiresInSeconds}s`);
  const viaQuery = await connect(minted.token, { query: true }).then(
    (ws) => {
      ws.close();
      return false;
    },
    () => true,
  );
  check('a token in the query string is refused', viaQuery);

  // 2. An unknown token is refused at the handshake, not after it.
  const refused = await connect('not-a-real-token').then(
    () => false,
    () => true,
  );
  check('refuses an unknown token', refused);

  // 3. The token is single use, so a stolen one is worth nothing twice.
  const first = await connect(minted.token);
  const output = collect(first);
  const replayed = await connect(minted.token).then(
    (ws) => {
      ws.close();
      return false;
    },
    () => true,
  );
  check('a token cannot be used twice', replayed);

  // 4. The attach renders the session's own screen. A line of text on it, not
  // a prompt character: `>` matched tmux's own `\x1b[>c` query, which arrives
  // whether or not the screen ever does.
  const attached = await output.waitFor(
    { test: (buffer) => screenLines(buffer).some((line) => line.trim().length > 0) },
    8000,
  );
  check('the session paints its screen on attach', Boolean(attached), `${output.buffer.length} bytes`);

  // 5. The keyboard reaches the session, and its output comes back.
  //
  // What comes back is a terminal's bytes, not text. This looked for the typed
  // line and the output as `marker\r\nmarker`, which holds only while tmux
  // writes the output as it happens. The resize just before the input makes
  // tmux repaint the whole screen, and a line it repaints ends in an
  // erase-to-end-of-line before its `\r\n`. When the command ran during that
  // repaint, its output was there and the check missed it: 7 runs in 30 on a
  // scratch install, every one with the output on screen.
  //
  // So the screen's text is read, and the command prints what nobody typed:
  // the marker is built by `printf` from two words, so the typed line can
  // never stand in for the output.
  const id = Date.now().toString(36);
  const marker = `fleetadlc-terminal-${id}`;
  first.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  first.send(JSON.stringify({ type: 'input', data: `printf '%s-%s\\n' fleetadlc-terminal ${id}\n` }));
  const printed = await output.waitFor(
    { test: (buffer) => screenLines(buffer).some((line) => line.trim() === marker) },
    10_000,
  );
  check(
    'typing into the session works and the output comes back',
    Boolean(printed),
    printed ? 'the command ran and printed' : `never saw ${marker} printed`,
  );
  if (!printed && process.env.TERMINAL_DEBUG) console.log(JSON.stringify(output.buffer.slice(-3000)));

  // 6. Detaching leaves the session running: that is the whole point.
  const second = await mintToken(session, 'terminal test');
  const detacher = await connect(second.token);
  detacher.send(JSON.stringify({ type: 'detach' }));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  detacher.close();
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const stillThere = await fetch(`${HOSTD}/bots/${BOT}/sessions`, { headers: authHeaders() }).then(
    (response) => response.json(),
  );
  check(
    'detaching leaves the session running',
    (stillThere.sessions ?? []).some((entry) => entry.name === session),
    `${(stillThere.sessions ?? []).length} session(s) still up`,
  );

  // 7. Every step is attributable to the person who did it, and says so as an
  // assertion by the principal hostd authenticated rather than as bare input.
  const audit = (await listAudit(50)).filter((row) => row.id > before);
  const actor = `${IDENTITY} via platform`;
  check('minting a token is audited', audit.some((row) => row.action === 'terminal.token' && row.actor === actor));
  check(
    'attaching is audited with the identity',
    audit.some((row) => row.action === 'terminal.attach' && row.actor === actor),
  );
  check('detaching is audited', audit.some((row) => row.action === 'terminal.detach' && row.actor === actor));
  check(
    'the audit names the principal that was authenticated, not the caller\u2019s word for it',
    audit.some((row) => row.action === 'terminal.token' && row.payload?.principal === 'platform'),
  );

  // 8. None of the above is reachable without the secret.
  const unauthenticated = await fetch(`${HOSTD}/terminal/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fleetadlc-on-behalf-of': 'root' },
    body: JSON.stringify({ bot: BOT, session }),
  });
  check(
    'minting a token without the secret is refused',
    unauthenticated.status === 401,
    `status ${unauthenticated.status}`,
  );
  const forged = await listAudit(10);
  check('a refused mint writes no audit row naming itself', !forged.some((row) => row.actor?.includes('root')));

  await query(`delete from audit where actor like '${IDENTITY}%'`);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} terminal checks passed\n`);
  await closePool();
  if (failed.length > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(`\nterminal checks failed: ${error instanceof Error ? error.message : error}\n`);
  await closePool();
  process.exit(1);
});

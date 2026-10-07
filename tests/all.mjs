#!/usr/bin/env node
/**
 * Runs every check in order and reports one verdict. The unit tests need
 * nothing; the pipeline, terminal and kill checks need a running install; the
 * live checks need a connected GitHub account, and run only when asked.
 *
 *   node tests/all.mjs          # everything available but the live checks
 *   node tests/all.mjs --live   # and the live checks, which write to GitHub
 *
 * The live checks used to run whenever the bridge said `acting as`, which in
 * practice only a real install does: a scratch one has no GitHub. So a plain
 * run on a machine whose real install was up skipped the integration checks as
 * unsafe there and then filed an issue, set `review-gate` on `main` and opened
 * a pull request in that install's production repository. `--no-live`, the old
 * way to skip them, is still accepted and changes nothing.
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const live = process.argv.includes('--live');

/**
 * The environment with the install's own settings taken out. The suites below
 * run with a scratch install's exported (`tests/scratch.sh env`), and the
 * unit tests inherited them: `FLEETADLC_SCRIPTED_ENGINES=1` turned off the
 * sign-in holds a dozen bridge tests are about, and they failed here while
 * passing in `make ci`. Unit tests need nothing running, so they get nothing.
 */
function withoutInstall(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith('FLEETADLC_') && !name.startsWith('FLEET_') && name !== 'DATABASE_URL'),
  );
}

const suites = [
  { name: 'unit tests', command: 'pnpm', args: ['test'], cwd: root, needs: 'nothing', hermetic: true },
  { name: 'pipeline', command: process.execPath, args: [join(here, 'pipeline.mjs')], cwd: root, needs: 'install' },
  { name: 'terminal', command: process.execPath, args: [join(here, 'terminal.mjs')], cwd: root, needs: 'install' },
  {
    name: 'kill and restart',
    command: process.execPath,
    args: [join(here, 'kill-and-restart.mjs')],
    cwd: root,
    needs: 'install',
  },
  {
    name: 'onboarding',
    command: process.execPath,
    args: [join(here, 'onboarding.mjs')],
    cwd: root,
    // A console and a scripted install: onboarding.mjs refuses a real one, and
    // on a machine whose real install was running it reported FAIL.
    needs: 'consoleAndInstall',
  },
  {
    name: 'concurrency',
    command: process.execPath,
    args: [join(here, 'concurrency.mjs')],
    cwd: root,
    needs: 'install',
  },
  {
    // Starts real containers on the machine's Docker, so only when asked:
    // FLEETADLC_DOCKER_COMPUTERS=1, against a scratch install on the docker driver.
    name: 'docker computers',
    command: process.execPath,
    args: [join(here, 'docker-computers.mjs')],
    cwd: root,
    needs: 'dockerComputers',
  },
  {
    name: 'github (live)',
    command: process.execPath,
    args: [join(here, 'github-live.mjs')],
    cwd: root,
    needs: 'github',
  },
  {
    name: 'github pull request (live)',
    command: process.execPath,
    args: [join(here, 'github-live-pr.mjs')],
    cwd: root,
    needs: 'github',
  },
  {
    name: 'terraform (gcp module)',
    command: 'terraform',
    args: ['validate'],
    cwd: join(root, 'infra', 'gcp'),
    needs: 'terraform',
  },
];

function run(suite) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(suite.command, suite.args, {
      cwd: suite.cwd,
      env: suite.hermetic ? withoutInstall(process.env) : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.on('error', () => resolve({ ...suite, code: 127, output, ms: Date.now() - started }));
    child.on('close', (code) => resolve({ ...suite, code: code ?? 1, output, ms: Date.now() - started }));
  });
}

/**
 * Whether an install answers, and whether its engines are scripted. The
 * integration checks write into the install's board, so a real one — which
 * answers at the default address on a machine that runs OpenADLC — is not one
 * they run against; see `scratch-only.mjs`.
 */
async function installState() {
  const bridge = process.env.FLEETADLC_BRIDGE_URL ?? 'http://127.0.0.1:47311';
  const health = await fetch(`${bridge}/healthz`)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  if (!health) return 'down';
  return health.scripted === true ? 'scripted' : 'real';
}

async function githubIsConnected() {
  const bridge = process.env.FLEETADLC_BRIDGE_URL ?? 'http://127.0.0.1:47311';
  return fetch(`${bridge}/healthz`)
    .then((response) => response.json())
    .then((body) => typeof body.github === 'string' && body.github.startsWith('acting as'))
    .catch(() => false);
}

async function consoleIsUp() {
  // `/` refuses a browser that has not signed in; `/signin` answers either way.
  const url = process.env.FLEETADLC_CONSOLE_URL ?? 'http://127.0.0.1:47300';
  return fetch(`${url}/signin`)
    .then((response) => response.ok)
    .catch(() => false);
}

async function terraformIsInstalled() {
  return new Promise((resolve) => {
    const child = spawn('terraform', ['version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * `terraform validate` needs the module's providers, which only `terraform init`
 * fetches. On a machine that never ran it, the check failed on that rather than
 * on anything in the module; `fleetadlc cloud validate` initialises and validates.
 */
function terraformIsInitialised() {
  return existsSync(join(root, 'infra', 'gcp', '.terraform'));
}

function summarise(output) {
  // Each suite prints its own tally; surface that rather than the whole log.
  const tally = output.match(/\d+\/\d+ [a-z ]*checks passed/i);
  if (tally) return tally[0];
  const tests = [...output.matchAll(/Tests\s+(\d+) passed \((\d+)\)/g)];
  if (tests.length > 0) {
    const passed = tests.reduce((total, match) => total + Number(match[1]), 0);
    return `${passed} unit tests passed across ${tests.length} packages`;
  }
  if (/Success! The configuration is valid/.test(output)) return 'the module is valid';
  return output.trim().split('\n').at(-1) ?? '';
}

async function main() {
  const available = {
    nothing: true,
    install: (await installState()) === 'scripted',
    github: live && (await githubIsConnected()),
    console: await consoleIsUp(),
    consoleAndInstall: (await consoleIsUp()) && (await installState()) === 'scripted',
    terraform: (await terraformIsInstalled()) && terraformIsInitialised(),
    dockerComputers: process.env.FLEETADLC_DOCKER_COMPUTERS === '1' && (await installState()) === 'scripted',
  };

  console.log('\nfleetadlc checks\n');
  if (!available.install && (await installState()) === 'real') {
    console.log(`  the install at ${process.env.FLEETADLC_BRIDGE_URL ?? 'http://127.0.0.1:47311'} is a real one, so the integration checks are skipped:`);
    console.log('  they write into the board of whatever install they run against');
  } else if (!available.install) {
    console.log('  the install is not running, so the integration checks are skipped');
    // Never plain `fleetadlc up`: it starts the install ~/.fleetadlc points at, the real one on a machine that runs OpenADLC.
    console.log('  start a scratch one: tests/scratch.sh up && eval "$(tests/scratch.sh env)"\n');
  }
  if (!available.terraform) {
    console.log('  terraform is missing or the gcp module is not initialised, so its check is skipped: fleetadlc cloud validate\n');
  }
  if (!available.console) {
    console.log('  the console is not running, so the onboarding checks are skipped\n');
  } else if (!available.consoleAndInstall) {
    console.log('  the console answers, but not for a scratch install, so the onboarding checks are skipped\n');
  }
  if (!available.github) {
    console.log(`  ${live ? 'no connected GitHub account, so the live checks are skipped' : 'the live checks run only with --live: they write to GitHub'}\n`);
  }

  const outcomes = [];
  for (const suite of suites) {
    if (!available[suite.needs]) {
      outcomes.push({ ...suite, skipped: true });
      console.log(`  skip  ${suite.name}`);
      continue;
    }

    const result = await run(suite);
    outcomes.push(result);
    const seconds = (result.ms / 1000).toFixed(1);
    console.log(
      `${result.code === 0 ? '  ok  ' : ' FAIL '} ${suite.name} (${seconds}s) — ${summarise(result.output)}`,
    );
    if (result.code !== 0) {
      const failures = result.output
        .split('\n')
        .filter((line) => /FAIL|error|failed/i.test(line))
        .slice(0, 8);
      for (const line of failures) console.log(`        ${line.trim()}`);
    }
  }

  const ran = outcomes.filter((outcome) => !outcome.skipped);
  const failed = ran.filter((outcome) => outcome.code !== 0);
  const skipped = outcomes.filter((outcome) => outcome.skipped);

  console.log(
    `\n${ran.length - failed.length}/${ran.length} suites passed${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}\n`,
  );
  process.exit(failed.length > 0 ? 1 : 0);
}

main();

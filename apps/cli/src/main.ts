import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSecretStore, internalSecretRef } from '@fleetadlc/github';
import { answerOf, attachFailure } from './attach.js';
import { rotateAttribution } from './commands/attribution.js';
import { authLogin, authStatus } from './commands/auth.js';
import { backup, restore, selectionFromFlags } from './commands/backup.js';
import { cloud } from './commands/cloud.js';
import { bridgeHeaders, consoleLink } from './console-link.js';
import { doctor, status } from './commands/doctor.js';
import { githubApply, githubCheck, syncLabels } from './commands/github.js';
import { init } from './commands/init.js';
import { down, up } from './commands/up.js';
import { configPath, databaseConflictMessage, databaseUrlConflict, loadConfig, serviceEnv } from './install.js';
import { logFile } from './processes.js';
import { ui } from './ui.js';
import { flagValue, hasFlag, refusal, strayArgument, unknownFlag, wantsHelp } from './flags.js';

function repoRoot(): string {
  // dist/main.js → apps/cli/dist → repository root
  const here = dirname(fileURLToPath(import.meta.url));
  const guess = resolve(here, '..', '..', '..');
  return existsSync(join(guess, 'pnpm-workspace.yaml')) ? guess : process.cwd();
}

// Thin, and spelled `flag('…')`/`has('…')` at each call: flags.test.ts reads
// those names out of this file to check each is in FLAGS.
function flag(name: string): string | undefined {
  return flagValue(process.argv, name);
}

function has(name: string): boolean {
  return hasFlag(process.argv, name);
}

const DATABASE_COMMANDS = new Set(['doctor', 'status', 'auth', 'backup', 'restore', 'seed', 'github']);

const USAGE = `
fleetadlc — a crew of agents that takes a request to a reviewed, deployed change

  fleetadlc COMMAND --help          what that command does, and nothing else
  fleetadlc init [--driver local|docker] [--database-url URL]
                                    where to set this install up (the console does it)
  fleetadlc up [--no-seed]          start the stack, and print a link that signs you in to the console;
                                    --no-seed skips reloading config/bots.yaml and config/repos.yaml
  fleetadlc console-link            a fresh sign-in link for the console (each one works for an hour)
  fleetadlc down                    stop the stack
  fleetadlc status                  what is running, what the board looks like, what it has cost
  fleetadlc doctor                  check the things that break an install
  fleetadlc auth login --bot NAME   connect one bot's GitHub account with the device flow
  fleetadlc auth login --all        connect every bot in turn; run fleetadlc up first,
                                    since the bridge connects each seat
  fleetadlc auth status             which accounts are connected
  fleetadlc attribution rotate [--drop-old]
                                    a new key for signing the crew's posts, made by
                                    the running bridge (POST /v1/attribution/rotate).
                                    The old key keeps checking posts for 30 days;
                                    after a leak, --drop-old stops it and every
                                    earlier key checking at once
  fleetadlc backup [--out PATH] [--unencrypted]
                                    encrypted copy of the whole install: settings and
                                    the App's key, repositories, the crew and their
                                    GitHub sign-ins, model accounts. Narrow it with
                                    --without install,repositories,crew,accounts,
                                    --bots SEAT,… or --accounts ID,…; add --history
                                    for threads, the audit log, costs and requests.
                                    Sign-ins come along for the whole install and
                                    not for part of it (--sign-ins, --no-sign-ins):
                                    GitHub rotates them, so a restored one moves to
                                    the new install
  fleetadlc restore PATH            put one of those archives back (--dry-run first).
                                    Every sign-in in it is checked first, and one
                                    that is expired or refused is never restored; a
                                    GitHub or subscription sign-in can only be
                                    checked by using it, which takes it over. On a
                                    clean install that is done; on one that is set
                                    up, only with --take-over-sign-ins. It names the
                                    bots that need to connect again
  fleetadlc attach BOT SESSION      take over a running session in the terminal
  fleetadlc logs [SERVICE]          where a service writes its log (the bridge's when none is named)
  fleetadlc seed                    reload config/bots.yaml and config/repos.yaml
  fleetadlc config                  print the path of this install's install.json
  fleetadlc github sync-labels [--repo NAME] [--file PATH]
                                    write config/labels.json to every repository
                                    (--repo NAME for one, --file PATH for another
                                    label file, such as config/labels-fleetadlc.json)
  fleetadlc github check            can the automation account reach the repositories,
                                    and are the repository rules in place
  fleetadlc github apply            create the rulesets, environments and CODEOWNERS;
                                    asks how production ships where nothing says:
                                    --production auto [--soak MINUTES] or
                                    --production reviewers --reviewer LOGIN[,LOGIN]
  fleetadlc cloud configure         set up a cloud install (gcp)
  fleetadlc cloud pull --bucket B [--prefix P]
                                    take over a cloud install's settings on this machine
  fleetadlc cloud push              save this machine's cloud settings back to the bucket
  fleetadlc cloud plan | apply      stand the install up on that cloud
  fleetadlc cloud output            the console and webhook URLs
  fleetadlc cloud validate          check the cloud module without touching the install
                                    Every cloud command takes --provider (gcp, the default)

The crew works on GitHub as the accounts you connect. Seats in a group may share one
account (the crew's, or the reviewers'); a reviewer can never share the crew account,
since GitHub won't let an account approve its own pull request. OpenADLC never stores
a personal access token: it keeps one refresh token per account and mints short-lived
user tokens.
`;

/**
 * The usage, or with a command the lines about it alone: `fleetadlc down -h`
 * says what down does and stops nothing.
 */
function usage(command?: string): void {
  if (command) {
    const entries: string[][] = [];
    for (const line of USAGE.split('\n')) {
      if (line.startsWith('  fleetadlc ')) entries.push([line]);
      else if (line.startsWith('    ') && entries.length > 0) entries[entries.length - 1]?.push(line);
    }
    const about = entries.filter(([first]) => (first as string).slice('  fleetadlc '.length).split(/\s/)[0] === command);
    if (about.length > 0) {
      ui.plain(about.flat().join('\n'));
      return;
    }
  }
  ui.plain(USAGE);
}

async function attach(root: string, bot: string, session: string): Promise<void> {
  const config = loadConfig(root);
  const failed = (said: { reason: string; hint: string }): void => {
    ui.fail(said.reason);
    ui.note(said.hint);
    process.exitCode = 1;
  };
  try {
    const response = await fetch(
      `http://127.0.0.1:${config.ports.bridge}/v1/terminal/${bot}/${session}/token`,
      // The bridge serves `/v1` only to the console and the CLI, which hold the console secret.
      { method: 'POST', headers: await bridgeHeaders() },
    ).catch(() => null);
    if (!response) return failed(attachFailure('bridge', 'unreachable', config.ports.bridge));
    if (!response.ok) return failed(attachFailure('bridge', await answerOf(response), config.ports.bridge));
    const { token } = (await response.json()) as { token: string };

    // hostd refuses a caller without the install's internal secret. The CLI runs
    // as the operator, so it reads it from the same secret store the bridge
    // wrote it to rather than being given one.
    const secret = await getSecretStore().get(internalSecretRef());
    if (!secret) throw new Error('this install has no internal secret yet; start it with `fleetadlc up`');

    const redeem = await fetch(`http://127.0.0.1:${config.ports.hostd}/terminal/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fleetadlc-internal-secret': secret },
      body: JSON.stringify({ token }),
    }).catch(() => null);
    if (!redeem) return failed(attachFailure('hostd', 'unreachable', config.ports.hostd));
    if (!redeem.ok) return failed(attachFailure('hostd', await answerOf(redeem), config.ports.hostd));
    const { command } = (await redeem.json()) as { command: string[] };

    ui.note('detach with ctrl-b d; detaching leaves the session running');
    const [binary, ...args] = command;
    execFileSync(binary as string, args, { stdio: 'inherit' });
  } catch (error) {
    ui.fail(error instanceof Error ? error.message : 'could not attach');
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const root = repoRoot();
  const [command, subcommand] = process.argv.slice(2);
  const args = process.argv.slice(3);

  // Before install.json is read, so a mistake in it cannot hide the help or
  // the path of the file to fix; and before anything runs, so
  // `fleetadlc down -h` says what down does instead of stopping the stack.
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') return usage(command === 'help' ? subcommand : undefined);
  if (wantsHelp(args)) return usage(command);

  const unknown = unknownFlag(command, args);
  if (unknown) {
    ui.fail(refusal(command, unknown, subcommand));
    if (unknown === '--demo') {
      ui.note('demo mode is gone. A scratch install that cannot touch yours: see docs/development.md');
    }
    process.exitCode = 2;
    return;
  }
  const stray = strayArgument(command, args);
  if (stray) {
    ui.fail(`fleetadlc ${command} takes no arguments, and was given ${stray}`);
    ui.note(`see: fleetadlc ${command} --help`);
    process.exitCode = 2;
    return;
  }

  if (command === 'config') {
    ui.plain(configPath());
    return;
  }

  const config = loadConfig(root);
  // Read before the loop below fills DATABASE_URL, after which an exported
  // value cannot be told from install.json's.
  const conflict = databaseUrlConflict(existsSync(configPath()) ? config : null, process.env);

  // The CLI is the only place these are assembled; every service reads them here.
  for (const [key, value] of Object.entries(serviceEnv(config))) {
    if (!process.env[key]) process.env[key] = value;
  }

  // The commands that open the database in this process. `up` gives the
  // services install.json's url whatever is exported, so these would act on
  // another database than the install's.
  if (conflict && command && DATABASE_COMMANDS.has(command)) {
    ui.fail(databaseConflictMessage(conflict));
    process.exitCode = 1;
    return;
  }

  switch (command) {
    case 'init':
      return init(root, { driver: flag('driver'), databaseUrl: flag('database-url') });

    case 'up':
      return up(config, { skipSeed: has('no-seed') });

    case 'down':
      return down();

    case 'status':
      return status(config);

    case 'console-link':
      await consoleLink(config.ports.console);
      return;

    case 'doctor':
      return doctor(config);

    case 'auth':
      if (subcommand === 'login') {
        return authLogin(config, { bot: flag('bot'), all: has('all') });
      }
      if (subcommand === 'status' || subcommand === undefined) return authStatus();
      ui.fail(`unknown auth command: ${subcommand}`);
      ui.note('try: fleetadlc auth login --bot SEAT | --all, or fleetadlc auth status');
      // 2, as for an unknown flag: `fleetadlc github chek && deploy` went on.
      process.exitCode = 2;
      return;

    case 'attribution':
      if (subcommand === 'rotate') {
        await rotateAttribution(config, { dropOld: has('drop-old') });
        return;
      }
      ui.fail(`unknown attribution command: ${subcommand ?? '(none)'}`);
      ui.note('try: fleetadlc attribution rotate [--drop-old]');
      process.exitCode = 2;
      return;

    case 'cloud': {
      const provider = flag('provider');
      const bucket = flag('bucket');
      const prefix = flag('prefix');
      return cloud(config, subcommand, {
        ...(provider ? { provider } : {}),
        ...(bucket ? { bucket } : {}),
        ...(prefix ? { prefix } : {}),
      });
    }

    case 'github':
      if (subcommand === 'sync-labels') {
        const repo = flag('repo');
        const file = flag('file');
        return syncLabels(config, { ...(repo ? { repo } : {}), ...(file ? { file } : {}) });
      }
      if (subcommand === 'check') return githubCheck(config);
      if (subcommand === 'apply') {
        // `--reviewer` may be given more than once, or as a comma-separated list.
        const reviewers = process.argv.flatMap((argument, index) => (argument === '--reviewer' && !(process.argv[index + 1] ?? '--').startsWith('--') ? [process.argv[index + 1] ?? ''] : []));
        const production = flag('production');
        const soak = flag('soak');
        return githubApply(config, {
          ...(production !== undefined ? { production } : {}),
          ...(reviewers.length > 0 ? { reviewers } : {}),
          ...(soak !== undefined ? { soak } : {}),
        });
      }
      ui.fail(`unknown github command: ${subcommand ?? '(none)'}`);
      ui.note('try: fleetadlc github sync-labels | fleetadlc github check | fleetadlc github apply');
      process.exitCode = 2;
      return;

    case 'backup': {
      const out = flag('out');
      const without = flag('without');
      const bots = flag('bots');
      const accounts = flag('accounts');
      const selection = selectionFromFlags({
        ...(without !== undefined ? { without } : {}),
        ...(bots !== undefined ? { bots } : {}),
        ...(accounts !== undefined ? { accounts } : {}),
        history: has('history'),
        ...(has('no-sign-ins') ? { signIns: false } : has('sign-ins') ? { signIns: true } : {}),
      });
      if ('error' in selection) {
        ui.fail(selection.error);
        process.exitCode = 1;
        return;
      }
      return backup(root, { ...(out ? { out } : {}), unencrypted: has('unencrypted'), selection });
    }

    case 'restore': {
      // The path is whichever argument is not a flag, so `--dry-run` may come first.
      const target = process.argv.slice(3).find((argument) => !argument.startsWith('--'));
      if (!target) {
        ui.fail('usage: fleetadlc restore PATH [--dry-run] [--take-over-sign-ins]');
        process.exitCode = 1;
        return;
      }
      return restore(target, { dryRun: has('dry-run'), takeOverSignIns: has('take-over-sign-ins') });
    }

    case 'attach': {
      const [, bot, session] = process.argv.slice(2);
      if (!bot || !session) {
        ui.fail('usage: fleetadlc attach BOT SESSION');
        process.exitCode = 2;
        return;
      }
      return attach(root, bot, session);
    }

    case 'logs': {
      const service = subcommand ?? 'bridge';
      ui.plain(logFile(service));
      return;
    }

    case 'seed': {
      const script = [join(root, 'packages/db/dist/cli/seed.js')];
      execFileSync(process.execPath, script, { stdio: 'inherit', env: process.env });
      return;
    }

    default:
      ui.fail(`unknown command: ${command}`);
      usage();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  ui.fail(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

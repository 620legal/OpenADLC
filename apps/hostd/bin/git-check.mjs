// What OpenADLC's `git` lets a task run, by its skill's `allow.git` rules. Run by
// the shell script beside this file as `node git-check.mjs <real git> <args…>`,
// for every git command a session runs while FLEETADLC_TOOLS_POLICY is set.
//
// The guard used to look only at an invocation whose arguments named `push`.
// A reviewer showed four ways past that, none needing the real git's full path:
// an alias given with `-c alias.p=push`, the same alias in GIT_CONFIG_*,
// `git send-pack`, and a global option that takes a value (`--attr-source
// HEAD push`) read as the command. So it fails closed now: every invocation is
// read, an alias is resolved the way git resolves it, a command that pushes
// without being `push` is refused, and a global option it does not know is
// refused rather than skipped.
//
// What a push would update is not read from its arguments. A refspec, a
// `push.default`, a `remote.<name>.push`, `HEAD` and `--all` all decide it, and
// git says itself: the same push with `--dry-run --porcelain` names every ref
// it would change and whether the change is forced. That costs one more round
// trip to the remote per push.
//
// It is a guard against a task that forgets or is talked into it, not a
// boundary: see docs/security.md for what it cannot stop.
//
// Plain Node with no dependencies, like `gh`: it runs inside the bot's image.
import { spawnSync } from 'node:child_process';

/** Global options that take their value as the next argument. */
const VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source']);
/** Global options that take their value after `=`. */
const VALUED_INLINE = ['--git-dir=', '--work-tree=', '--namespace=', '--super-prefix=', '--config-env=', '--attr-source=', '--exec-path=', '--list-cmds='];
/** Global options that take no value. */
const FLAGS = new Set([
  '-p', '-P', '--paginate', '--no-pager', '--bare', '--no-replace-objects', '--literal-pathspecs', '--glob-pathspecs',
  '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-advice', '--no-lazy-fetch', '--exec-path',
  '--html-path', '--man-path', '--info-path', '--version', '-v', '--help', '-h',
]);

/** Built-in commands a session runs all the time; see `resolveAliases`. */
const COMMON_BUILTINS = new Set([
  'add', 'am', 'apply', 'bisect', 'blame', 'branch', 'cat-file', 'check-ignore', 'checkout', 'cherry-pick', 'clean',
  'clone', 'commit', 'config', 'describe', 'diff', 'diff-tree', 'fetch', 'for-each-ref', 'format-patch', 'grep', 'init',
  'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge', 'merge-base', 'mv', 'pull', 'push', 'rebase', 'remote', 'reset',
  'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'shortlog', 'show', 'show-ref', 'stash', 'status', 'submodule',
  'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref', 'var', 'version', 'worktree', 'help',
]);

/** Commands that update a remote's refs without being `push`. */
const PUSHES_OTHERWISE = new Set(['send-pack', 'http-push']);

/** Configuration a session's environment may not set while a task's rules apply. */
const GUARDED_KEY = /^(alias\..+|push\..+|remote\..+\.(push|pushurl)|url\..+\.(insteadof|pushinsteadof)|help\.autocorrect)$/i;

/**
 * The global options and the command, or why they cannot be read: `{ globals,
 * at }`, where `at` is the command's index (-1 when there is none), or
 * `{ refusal }`.
 */
export function readGlobals(args) {
  const globals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) return { globals, at: i };
    if (VALUED.has(arg)) {
      if (i + 1 >= args.length) return { refusal: `${arg} is missing its value` };
      if ((arg === '-c' || arg === '--config-env') && GUARDED_KEY.test(configKey(args[i + 1]))) {
        return { refusal: `a task does not set ${configKey(args[i + 1])} on the command line` };
      }
      globals.push(arg, args[++i]);
      continue;
    }
    const inline = VALUED_INLINE.find((prefix) => arg.startsWith(prefix));
    if (inline) {
      if (inline === '--config-env=' && GUARDED_KEY.test(configKey(arg.slice(inline.length)))) {
        return { refusal: `a task does not set ${configKey(arg.slice(inline.length))} on the command line` };
      }
      globals.push(arg);
      continue;
    }
    if (FLAGS.has(arg)) {
      globals.push(arg);
      continue;
    }
    return { refusal: `git option ${arg} is not one OpenADLC's git knows, so it is not run` };
  }
  return { globals, at: -1 };
}

/** The key of `-c key=value` or `--config-env key=ENV`. */
function configKey(assignment) {
  const eq = assignment.indexOf('=');
  return (eq < 0 ? assignment : assignment.slice(0, eq)).trim();
}

/**
 * The session's environment without GIT_CONFIG_* entries a task may not set:
 * aliases, push settings and URL rewrites, and autocorrect, which runs a
 * mistyped command as the one it guessed. GIT_CONFIG_PARAMETERS is how git
 * hands `-c` to what it runs, so it is dropped outright. Autocorrect is turned
 * off for every command, whatever a file says.
 */
export function guardedEnv(env) {
  const kept = [];
  const count = Number(env.GIT_CONFIG_COUNT ?? 0) || 0;
  for (let i = 0; i < count; i++) {
    const key = env[`GIT_CONFIG_KEY_${i}`];
    if (key === undefined) continue;
    if (!GUARDED_KEY.test(key)) kept.push([key, env[`GIT_CONFIG_VALUE_${i}`] ?? '']);
  }
  kept.push(['help.autocorrect', '0']);
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(name)) continue;
    out[name] = value;
  }
  out.GIT_CONFIG_COUNT = String(kept.length);
  kept.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${i}`] = key;
    out[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return out;
}

/** An alias's value as words, the way git splits it: whitespace, and quotes that group. */
export function splitAlias(value) {
  const words = [];
  let word = null;
  let quote = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < value.length) word = (word ?? '') + value[++i];
      else word = (word ?? '') + ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word ??= '';
    } else if (ch === '\\' && i + 1 < value.length) {
      word = (word ?? '') + value[++i];
    } else if (/\s/.test(ch)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + ch;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/**
 * The arguments with every alias expanded, as git would run them, or a
 * refusal. `ask` runs the real git and returns its stdout, or null when it
 * failed. An alias of a built-in command is ignored by git, and so here.
 */
export function resolveAliases(args, ask) {
  let current = args;
  for (let depth = 0; depth < 10; depth++) {
    const read = readGlobals(current);
    if (read.refusal) return read;
    if (read.at < 0) return { args: current, globals: read.globals, at: -1 };
    const command = current[read.at];
    // Git never lets an alias stand for a built-in command, so the everyday
    // ones are run without asking for one: two more processes on every call
    // is what a session running git hundreds of times would pay otherwise.
    if (COMMON_BUILTINS.has(command)) return { args: current, globals: read.globals, at: read.at };
    const value = ask([...read.globals, 'config', '--get', `alias.${command}`]);
    if (value === null || value.trim() === '') return { args: current, globals: read.globals, at: read.at };
    const builtins = ask(['--list-cmds=builtins']) ?? '';
    if (builtins.split('\n').includes(command)) return { args: current, globals: read.globals, at: read.at };
    const expansion = value.trim();
    if (expansion.startsWith('!')) {
      return { refusal: `alias ${command} runs a shell command, which OpenADLC's git cannot read, so it is not run` };
    }
    current = [...read.globals, ...splitAlias(expansion), ...current.slice(read.at + 1)];
  }
  return { refusal: 'aliases that expand into each other more than ten times are not run' };
}

/**
 * Options that make a command run a command of its own, by the command they
 * belong to: the long option, and its one-letter spelling where it has one.
 */
const RUNS_A_COMMAND = {
  rebase: { long: ['--exec'], short: 'x' },
  difftool: { long: ['--extcmd'], short: 'x' },
  fetch: { long: ['--upload-pack'] },
  pull: { long: ['--upload-pack'] },
  'ls-remote': { long: ['--upload-pack'] },
  clone: { long: ['--upload-pack'], short: 'u' },
  // Plumbing and the less obvious: what runs is a program on this machine when
  // the remote is a path, or the pager the files are opened in.
  'fetch-pack': { long: ['--upload-pack', '--exec'] },
  archive: { long: ['--exec'] },
  grep: { long: ['--open-files-in-pager'], short: 'O' },
};

/**
 * The long option `arg` means, spelled out. Git takes any unique prefix of a
 * long option — `git rebase --exe 'git push …'` runs the command as `--exec`
 * would — so a refusal that compared names let an abbreviation through. The
 * prefix is resolved against the command's own options, as git lists them
 * (`--git-completion-helper`), with the refused ones added: git leaves some
 * out of that list (`grep --open-files-in-pager`), and where the list cannot
 * be had at all the refused ones are all there is to compare with. A prefix
 * git would find ambiguous fails there anyway.
 */
export function longOption(arg, known, refused) {
  if (!arg.startsWith('--') || arg === '--') return null;
  const name = arg.split('=')[0];
  if (name.length <= 2) return null;
  const options = [...new Set([...known, ...refused])];
  if (options.includes(name)) return name;
  const matches = options.filter((option) => option.startsWith(name));
  return matches.length === 1 ? matches[0] : null;
}

/** A command's long options, from git itself, or none when it would not say. */
function optionsOf(command, ask) {
  const listed = ask ? ask([command, '--git-completion-helper']) : null;
  return (listed ?? '')
    .split(/\s+/)
    .filter((word) => /^--[a-z0-9][a-z0-9-]*=?$/.test(word))
    .map((word) => word.replace(/=$/, ''));
}

/** Why a command that is not `push` may not run, or null when it may. */
export function commandRefusal(command, rest, ask = null) {
  if (PUSHES_OTHERWISE.has(command)) return `git ${command} updates a remote's refs, and a task pushes only with git push`;
  if (command.startsWith('remote-')) return `git ${command} is a transport helper, which a task does not run by hand`;
  if (command === 'subtree' && rest.includes('push')) return "git subtree push pushes around OpenADLC's git, so it is not run";
  // Commands that run a command of their own. What they run finds git's own
  // binary ahead of this one on the PATH git gives it, so a push inside one is
  // never read here: `git rebase -x 'git push origin HEAD:main'` went through.
  if (command === 'filter-branch') return "git filter-branch runs its filters as commands OpenADLC's git cannot read, so it is not run";
  const runner = RUNS_A_COMMAND[command];
  if (runner) {
    const known = optionsOf(command, ask);
    const short = runner.short ? new RegExp(`^-(?!X)[a-zA-Z]*${runner.short}`) : null;
    const hit = rest.find((arg) => {
      if (arg === '--') return false;
      if (short && !arg.startsWith('--') && short.test(arg)) return true;
      const option = longOption(arg, known, runner.long);
      return option !== null && runner.long.includes(option);
    });
    if (hit) return `git ${command} ${hit.split('=')[0]} runs a command OpenADLC's git cannot read, so it is not run`;
  }
  const verb = rest.find((arg) => !arg.startsWith('-'));
  if (command === 'bisect' && verb === 'run') {
    return "git bisect run runs a command OpenADLC's git cannot read, so it is not run; step with git bisect good and bad";
  }
  if (command === 'submodule' && verb === 'foreach') {
    return "git submodule foreach runs commands OpenADLC's git cannot read, so it is not run";
  }
  return null;
}

/**
 * The refs a dry run said it would change: `{ flag, from, to }` for each line
 * of `--porcelain` output, whose lines are `<flag>\t<from>:<to>\t<summary>`.
 */
export function porcelainRefs(stdout) {
  const refs = [];
  for (const line of stdout.split('\n')) {
    const match = /^([ +\-*=!])\t([^\t]*)\t/.exec(line);
    if (!match) continue;
    const spec = match[2];
    const colon = spec.lastIndexOf(':');
    refs.push({ flag: match[1], from: spec.slice(0, colon), to: spec.slice(colon + 1) });
  }
  return refs;
}

/**
 * Why a push may not go for want of local CI, or null when it may.
 *
 * GitHub's CI on a crew pull request runs only after the lead approves, so
 * what a builder pushes is reviewed on the strength of its own run of the
 * checks — and that run is hostd's, recorded by the bridge for a commit
 * (`fleetadlc-ci`), not the builder's word. Each commit a push would put on a
 * branch needs a pass; one the remote already has, or a deletion, needs none.
 * `resolve` names a ref's commit; `passed` asks the bridge, and answers null
 * when it could not.
 */
export async function localCiPushRefusal(refs, policy, resolve, passed) {
  if (!policy?.localCi) return null;
  for (const { flag, from, to } of refs) {
    if (flag === '=' || flag === '!' || flag === '-' || !from) continue;
    const sha = resolve(from);
    if (!sha) return `could not read which commit ${from} is, to check it passed local CI`;
    const answer = await passed(sha);
    if (answer === null) return 'could not ask the bridge whether this commit passed local CI; run fleetadlc-ci and push again';
    if (!answer) return `${sha.slice(0, 7)} (${to}) has no recorded local CI pass: run fleetadlc-ci on it, then push`;
  }
  return null;
}

/** Whether the bridge has a local CI pass for a commit in this task's repository, or null when it could not be asked. */
export async function bridgePassed(sha, env = process.env, fetchImpl = globalThis.fetch) {
  const bridge = env.FLEETADLC_BRIDGE_URL;
  const task = env.FLEETADLC_TASK_ID;
  if (!bridge || !task || !fetchImpl) return null;
  try {
    const response = await fetchImpl(`${bridge}/internal/tasks/${encodeURIComponent(task)}/local-ci/pass`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(env.FLEETADLC_TASK_TOKEN ? { 'x-fleetadlc-task-token': env.FLEETADLC_TASK_TOKEN } : {}) },
      body: JSON.stringify({ sha }),
    });
    if (!response.ok) return null;
    return (await response.json())?.passed === true;
  } catch {
    return null;
  }
}

/** Why a push that would change these refs may not go, or null when it may. */
export function pushRefusal(refs, policy) {
  const prefix = policy?.pushBranchPrefix;
  if (!prefix || (policy?.denyGithub ?? []).includes('push')) {
    return "this task's skill does not push (its tools.yaml has no allow.git.push_branch_prefix, or denies push)";
  }
  for (const { flag, to } of refs) {
    // Already there, or refused by the remote: the push changes nothing here.
    if (flag === '=' || flag === '!') continue;
    const branch = to.startsWith('refs/heads/') ? to.slice('refs/heads/'.length) : null;
    if (branch === null || !branch.startsWith(prefix)) {
      return `this task pushes only to branches starting with ${prefix}, and this would update ${to}`;
    }
    if (flag === '+' && !policy.forcePush) {
      return `this would rewrite ${branch}'s history (a forced update), and this task's skill does not force-push`;
    }
  }
  return null;
}

/**
 * A push's arguments without `-q`. A quiet dry run prints none of the refs it
 * would change, so the push read as changing nothing and went through
 * unchecked: `git push -q origin main` passed the branch rule. The dry run is
 * asked loudly; the push itself keeps what the session asked for.
 */
export function withoutQuiet(pushArgs) {
  const out = [];
  for (let i = 0; i < pushArgs.length; i++) {
    const arg = pushArgs[i];
    if (arg === '--') {
      out.push(...pushArgs.slice(i));
      break;
    }
    if (PUSH_VALUED.has(arg)) {
      out.push(arg, pushArgs[++i]);
      continue;
    }
    if (arg === '-q' || arg === '--quiet') continue;
    if (/^-[a-zA-Z]+$/.test(arg) && arg.includes('q')) {
      const kept = arg.replace(/q/g, '');
      if (kept !== '-') out.push(kept);
      continue;
    }
    out.push(arg);
  }
  return out;
}

/**
 * The push options that undo the shim's own dry run. The dry run puts the
 * task's arguments after `--dry-run --porcelain`, and git takes the last of
 * two conflicting flags: `--no-porcelain` left a dry run that named no refs,
 * read as changing nothing, and `--no-dry-run` made the dry run the real push,
 * both straight to main.
 */
const UNDOES_DRY_RUN = ['--no-dry-run', '--no-porcelain'];

/**
 * Why a push's arguments may not run, when one would turn off the dry run or
 * its porcelain output, spelled out or abbreviated; null otherwise. What comes
 * after `--` is a refspec, not an option.
 */
export function dryRunRefusal(pushArgs, known = []) {
  for (let i = 0; i < pushArgs.length; i++) {
    const arg = pushArgs[i];
    if (arg === '--') break;
    if (PUSH_VALUED.has(arg)) {
      i += 1;
      continue;
    }
    const option = longOption(arg, known, UNDOES_DRY_RUN);
    if (option !== null && UNDOES_DRY_RUN.includes(option)) {
      return `git push ${arg} would turn off the dry run OpenADLC's git checks a push with, so it is not run`;
    }
  }
  return null;
}

/**
 * Whether a dry run's output is porcelain git finished printing: its last
 * line is `Done`, even when there was nothing to push. Output without it was
 * not read as refs at all, and naming no refs is not the same as changing none.
 */
export function porcelainDone(stdout) {
  return stdout.split('\n').some((line) => line.trim() === 'Done');
}

/** `git push` options that take their value as the next argument. */
const PUSH_VALUED = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

/**
 * A push's arguments with every way of asking for a forced update taken out,
 * for a skill that may not force.
 *
 * The dry run said the push is not forced, but the remote can move between it
 * and the real push; `--force` or a `+` left in would then rewrite what the dry
 * run never saw. Without them, git refuses a push that is no longer a fast
 * forward.
 */
export function withoutForce(pushArgs) {
  const out = [];
  let positional = 0;
  let optionsEnded = false;
  for (let i = 0; i < pushArgs.length; i++) {
    const arg = pushArgs[i];
    if (arg === '--' && !optionsEnded) {
      optionsEnded = true;
      out.push(arg);
      continue;
    }
    if (optionsEnded) {
      positional += 1;
      out.push(positional > 1 && arg.startsWith('+') ? arg.slice(1) : arg);
      continue;
    }
    if (PUSH_VALUED.has(arg)) {
      out.push(arg, pushArgs[++i]);
      continue;
    }
    if (arg === '--force' || arg === '--force-if-includes' || arg === '--force-with-lease' || arg.startsWith('--force-with-lease=')) continue;
    if (/^-[a-zA-Z]+$/.test(arg)) {
      const kept = arg.replace(/f/g, '');
      if (kept !== '-') out.push(kept);
      continue;
    }
    if (arg.startsWith('-')) {
      out.push(arg);
      continue;
    }
    positional += 1;
    out.push(positional > 1 && arg.startsWith('+') ? arg.slice(1) : arg);
  }
  return out;
}

async function main() {
  const [real, ...args] = process.argv.slice(2);
  const env = guardedEnv(process.env);
  const ask = (argv) => {
    const asked = spawnSync(real, argv, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] });
    return asked.status === 0 ? asked.stdout : null;
  };
  const refuse = (refusal) => {
    process.stderr.write(`git: not running — ${refusal}\n`);
    process.exit(1);
  };
  const run = (argv) => {
    const ran = spawnSync(real, argv, { stdio: 'inherit', env });
    process.exit(ran.status ?? 1);
  };

  let policy = null;
  try {
    policy = JSON.parse(process.env.FLEETADLC_TOOLS_POLICY ?? '');
  } catch {
    refuse("could not read this task's rules (FLEETADLC_TOOLS_POLICY)");
  }

  const resolved = resolveAliases(args, ask);
  if (resolved.refusal) refuse(resolved.refusal);
  const { args: expanded, globals, at } = resolved;
  if (at < 0) run(expanded);

  const command = expanded[at];
  const rest = expanded.slice(at + 1);
  if (command !== 'push') {
    const refusal = commandRefusal(command, rest, (argv) => ask([...globals, ...argv]));
    if (refusal) refuse(refusal);
    run(expanded);
  }

  if (pushRefusal([], policy)) refuse(pushRefusal([], policy));
  if (!policy.forcePush && rest.includes('--mirror')) refuse("--mirror pushes with force, and this task's skill does not force-push");

  // Before anything runs: with `--no-dry-run` the dry run is itself the push.
  const undoes = dryRunRefusal(rest, optionsOf('push', (argv) => ask([...globals, ...argv])));
  if (undoes) refuse(undoes);
  const dry = spawnSync(real, [...globals, 'push', '--dry-run', '--porcelain', ...withoutQuiet(rest)], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const refs = porcelainRefs(dry.stdout ?? '');
  if (refs.length === 0 && dry.status !== 0) {
    // The push could not even be tried — no remote, no access, no network.
    // The real one would fail the same way; say what git said.
    process.stderr.write(dry.stderr ?? '');
    process.exit(dry.status ?? 1);
  }
  if (dry.status === 0 && !porcelainDone(dry.stdout ?? '')) {
    refuse("the dry run's output could not be read as the refs this push would change");
  }

  const refusal = pushRefusal(refs, policy);
  if (refusal) refuse(refusal);
  const unchecked = await localCiPushRefusal(
    refs,
    policy,
    (ref) => ask([...globals, 'rev-parse', '--verify', `${ref}^{commit}`])?.trim() || null,
    (sha) => bridgePassed(sha),
  );
  if (unchecked) refuse(unchecked);
  run([...globals, 'push', ...(policy.forcePush ? rest : withoutForce(rest))]);
}

if (process.argv[1]?.endsWith('git-check.mjs')) await main();

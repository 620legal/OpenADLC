/**
 * The flags each command reads. Anything else is refused rather than ignored.
 *
 * A flag the CLI did not read did nothing and said nothing. `fleetadlc up --demo`,
 * still in the contributing guide after demo mode went, started whatever real
 * install `~/.fleetadlc` pointed at, and `--skip-seed` for `--no-seed` ran the seed
 * it was meant to skip.
 */
export const FLAGS: Readonly<Record<string, readonly string[]>> = {
  init: ['driver', 'database-url'],
  up: ['no-seed'],
  down: [],
  status: [],
  'console-link': [],
  doctor: [],
  // A command with subcommands is listed by subcommand. Listed by command, a flag
  // one subcommand reads was taken by its siblings and ignored:
  // `github apply --repo acme/one` wrote to every repository, and
  // `cloud plan --bucket other` planned against the saved bucket.
  'auth login': ['bot', 'all'],
  'auth status': [],
  'attribution rotate': ['drop-old'],
  'cloud configure': ['provider'],
  'cloud pull': ['provider', 'bucket', 'prefix'],
  'cloud push': ['provider'],
  'cloud plan': ['provider'],
  'cloud apply': ['provider'],
  'cloud output': ['provider'],
  'cloud validate': ['provider'],
  'github sync-labels': ['repo', 'file'],
  'github check': [],
  'github apply': ['production', 'reviewer', 'soak'],
  backup: ['out', 'without', 'bots', 'accounts', 'history', 'sign-ins', 'no-sign-ins', 'unencrypted'],
  restore: ['dry-run', 'take-over-sign-ins'],
  attach: [],
  logs: [],
  seed: [],
  config: [],
};

/** What a command runs given no subcommand: `fleetadlc auth` is `auth status`. */
const DEFAULT_SUBCOMMAND: Readonly<Record<string, string>> = { auth: 'status' };

/**
 * The FLAGS entry for a command line: `command subcommand` where there is one,
 * else the command. `first` is the argument after the command, which for
 * backup and restore may be a flag or a path, and so falls back to the command.
 */
function entry(command: string, first: string | undefined): string | undefined {
  const subcommand = first !== undefined && !first.startsWith('-') ? first : DEFAULT_SUBCOMMAND[command];
  if (subcommand !== undefined && FLAGS[`${command} ${subcommand}`]) return `${command} ${subcommand}`;
  return FLAGS[command] ? command : undefined;
}

/**
 * The first flag a command does not read, or null. `args` are the arguments
 * after the command, its subcommand first. A command or subcommand this table
 * does not know is left to say so itself, and so is help.
 *
 * A single dash is a flag too: no command takes one, and `-x` passed over as
 * if it were a path or a name let `fleetadlc config -x` print and succeed.
 */
export function unknownFlag(command: string | undefined, args: readonly string[]): string | null {
  const name = command ? entry(command, args[0]) : undefined;
  const known = name ? FLAGS[name] : undefined;
  if (!known) return null;
  for (const argument of args) {
    if (!argument.startsWith('-')) continue;
    if (!argument.startsWith('--')) return argument;
    const flag = argument.slice(2).split('=')[0] ?? '';
    if (!known.includes(flag)) return argument;
  }
  return null;
}

/** Whether the arguments after a command ask for its help rather than for it to run. */
export function wantsHelp(args: readonly string[]): boolean {
  return args.some((argument) => argument === '-h' || argument === '--help');
}

/**
 * Commands that take no argument but their flags, none of which takes a value.
 * One given anything else was run all the same: `fleetadlc down stop-nothing`
 * stopped the stack.
 */
const NO_ARGUMENTS = new Set(['up', 'down', 'status', 'console-link', 'doctor', 'seed', 'config']);

/** The first argument a command that takes none was given, or null. */
export function strayArgument(command: string, args: readonly string[]): string | null {
  if (!NO_ARGUMENTS.has(command)) return null;
  return args.find((argument) => !argument.startsWith('-')) ?? null;
}

/**
 * What to say about a flag a command does not take. `subcommand` is the
 * argument after the command, as `unknownFlag` read it.
 */
export function refusal(command: string, argument: string, subcommand?: string): string {
  const name = entry(command, subcommand) ?? command;
  const known = FLAGS[name] ?? [];
  const takes = known.length > 0 ? `it takes ${known.map((flag) => `--${flag}`).join(', ')}` : 'it takes no flags';
  return `fleetadlc ${name} does not take ${argument}; ${takes}`;
}

/**
 * Where `--name` is in `argv`, written alone or as `--name=value`, and the
 * value written after its `=`, if it was.
 *
 * Reading only `--name value` let `--name=value` past the check above and then
 * dropped it: `backup --without=crew --out=/secure/x` wrote the whole install,
 * unencrypted when asked, to the default path.
 */
function findFlag(argv: readonly string[], name: string): { index: number; inline?: string } | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === `--${name}`) return { index };
    // Split on the first `=` only: a database URL carries its own.
    if (argument.startsWith(`--${name}=`)) return { index, inline: argument.slice(name.length + 3) };
  }
  return undefined;
}

/**
 * A flag's value: what follows `=`, or the next argument. A flag with no value,
 * or followed by another flag, reads as ''; one not given, as undefined.
 */
export function flagValue(argv: readonly string[], name: string): string | undefined {
  const found = findFlag(argv, name);
  if (!found) return undefined;
  if (found.inline !== undefined) return found.inline;
  const value = argv[found.index + 1];
  return value && !value.startsWith('--') ? value : '';
}

/** Whether a flag was given, as `--name` or `--name=…`. */
export function hasFlag(argv: readonly string[], name: string): boolean {
  return findFlag(argv, name) !== undefined;
}

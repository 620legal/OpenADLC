/**
 * A task's credentials never go on a command line. Anything hostd starts —
 * `docker exec`, `docker run`, `tmux new-session`, `env` — shows its
 * arguments to every process on the host in `ps`, and one started inside a
 * task's container to every process there. So a credential is handed over in
 * the child's own environment (`docker … -e NAME`, valued in the docker
 * client's environment), in a file only its reader can open, which the
 * reader removes (`sessionEnvFile`), or on stdin.
 */

/** The variables a task's credentials travel in. */
const CREDENTIAL_NAMES = new Set([
  // The task's own database, whose URL carries its password.
  'DATABASE_URL',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'FLEETADLC_TASK_TOKEN',
  'FLEETADLC_REGISTRY_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'XAI_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);

/**
 * Whether a variable holds a credential: one of the names above, any other
 * `…_TOKEN`, `…_SECRET`, `…_PASSWORD` or `…_API_KEY`, and git's per-call
 * settings, which carry a push's `Authorization` header (`gitAuthEnv`).
 */
export function isCredentialEnv(name: string): boolean {
  return CREDENTIAL_NAMES.has(name) || /(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY)$/.test(name) || /^GIT_CONFIG_VALUE_\d+$/.test(name);
}

/**
 * A session's environment as lines `set -a` and `.` read back exactly: each
 * value in single quotes, a quote in it closed, escaped and reopened.
 */
export function sessionEnvFile(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`${JSON.stringify(name)} cannot be a session's environment variable`);
      return `${name}='${value.replaceAll("'", `'\\''`)}'\n`;
    })
    .join('');
}

/**
 * What a session runs, ahead of the env file's path and its own command: a
 * shell that reads the file into its environment, removes it, and becomes
 * the command.
 */
export const FROM_ENV_FILE = ['/bin/sh', '-c', 'set -a && . "$0" && rm -f "$0" && exec "$@"'] as const;

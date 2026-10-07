/**
 * The variables an account's key goes into.
 *
 * Codex's `exec` no longer reads `OPENAI_API_KEY`: given only that, it sends
 * no credential at all and OpenAI answers 401 "Missing bearer or basic
 * authentication in header" — every Codex bot on an OpenAI key failed its
 * first call, the owner's lead and security reviewers among them. It reads
 * `CODEX_API_KEY`. The key goes in under both, so a Codex older or newer than
 * 0.155 finds it, and so does anything else in the session that uses OpenAI.
 */
export function keyEnv(envVar: string, key: string): Record<string, string> {
  return envVar === 'OPENAI_API_KEY' ? { OPENAI_API_KEY: key, CODEX_API_KEY: key } : { [envVar]: key };
}

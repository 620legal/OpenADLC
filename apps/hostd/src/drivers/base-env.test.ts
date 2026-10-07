import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTAINER_GH_SHIM_DIR, TELEMETRY_OPT_OUTS, containerBaseEnv, hostBaseEnv, withRepoHome } from './base-env.js';

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

describe('what a session starts with', () => {
  it('does not carry the platform database into a bot session', () => {
    // hostd runs with this set; a bot that inherited it could rewrite the
    // ledger and the audit trail that hold it to account.
    process.env.DATABASE_URL = 'postgres://fleetadlc:fleetadlc@127.0.0.1:47432/fleetadlc_db';
    expect(hostBaseEnv()).not.toHaveProperty('DATABASE_URL');
  });

  it('leaves the rest of hostd behind too', () => {
    process.env.FLEETADLC_WEBHOOK_SECRET = 'shhh';
    process.env.ANTHROPIC_API_KEY = 'sk-not-this-one';
    const base = hostBaseEnv();
    expect(base).not.toHaveProperty('FLEETADLC_WEBHOOK_SECRET');
    expect(base).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('still gives a session enough to run something', () => {
    const base = hostBaseEnv();
    expect(base.PATH).toBeTruthy();
    expect(base.TERM).toBeTruthy();
  });

  it('uses the container’s own paths, not the host’s', () => {
    process.env.HOME = '/root';
    const base = containerBaseEnv();
    expect(base.HOME).toBe('/home/bot');
    expect(base.USER).toBe('bot');
  });

  it('tells the engines a container session is in its sandbox already, and a host session is not', () => {
    // Codex sandboxes each command with bubblewrap, which cannot start in the
    // bot's container: every command a reviewer ran there failed.
    expect(containerBaseEnv().FLEETADLC_CONTAINED).toBe('1');
    expect(hostBaseEnv()).not.toHaveProperty('FLEETADLC_CONTAINED');
  });
});

describe('the PATH a bot’s session gets', () => {
  /** The directories the bot image puts on its own PATH, from its Dockerfile. */
  function imagePath(): string[] {
    const dockerfile = readFileSync(
      fileURLToPath(new URL('../../../../infra/local/Dockerfile.bot', import.meta.url)),
      'utf8',
    );
    const line = /\bPATH=([^\s\\]+)/.exec(dockerfile);
    if (!line?.[1]) throw new Error('infra/local/Dockerfile.bot sets no PATH');
    return line[1].split(':').filter((dir) => dir && dir !== '$PATH');
  }

  it('reaches everything the image puts on its PATH, where the engine CLIs are installed', () => {
    // Sessions start under `env -i`, so the image's own PATH never reaches
    // them. It once listed only the system directories, the CLIs were in
    // ~/.local/bin, and every task failed with "engine claude is not
    // available on this host" inside a container that had it.
    const session = containerBaseEnv().PATH!.split(':');

    expect(imagePath().length).toBeGreaterThan(0);
    for (const dir of imagePath()) expect(session).toContain(dir);
    expect(session).toContain('/home/bot/.local/bin');
  });

  it('puts OpenADLC’s wrappers first again in a login shell, which resets PATH', () => {
    // Codex and grok run commands in login shells; Debian's /etc/profile sets
    // PATH outright, so their `gh pr review` was the real gh, unsigned, and a
    // review on an account seats share counted for no seat.
    const dockerfile = readFileSync(fileURLToPath(new URL('../../../../infra/local/Dockerfile.bot', import.meta.url)), 'utf8');
    expect(dockerfile).toMatch(/\/etc\/profile\.d\/[^\s']*fleetadlc[^\s']*\.sh/);
    expect(dockerfile).toContain(`PATH="${CONTAINER_GH_SHIM_DIR}:`);
  });

  it('puts OpenADLC’s own gh first, then the image’s directories, as the image does', () => {
    const session = containerBaseEnv().PATH!.split(':');
    // OpenADLC's gh heads what the session posts to GitHub, so it comes before the real one.
    expect(session[0]).toBe('/opt/fleetadlc/bin');
    expect(session.slice(1, imagePath().length + 1)).toEqual(imagePath());
  });
});

describe('the engine vendors’ telemetry in a session', () => {
  it('is turned off by every switch, under both drivers, unless the operator opted in', () => {
    expect(TELEMETRY_OPT_OUTS).toEqual({
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DO_NOT_TRACK: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      GROK_TELEMETRY_ENABLED: '0',
      GROK_TELEMETRY_MIXPANEL_ENABLED: '0',
      GROK_TELEMETRY_TRACE_UPLOAD: '0',
      GROK_FEEDBACK_ENABLED: '0',
      NEXT_TELEMETRY_DISABLED: '1',
    });
    for (const setting of [undefined, 'off', 'yes']) {
      if (setting === undefined) delete process.env.FLEETADLC_ENGINE_TELEMETRY;
      else process.env.FLEETADLC_ENGINE_TELEMETRY = setting;
      for (const env of [hostBaseEnv(), containerBaseEnv()]) {
        expect(env, String(setting)).toMatchObject(TELEMETRY_OPT_OUTS);
        expect(env).not.toHaveProperty('FLEETADLC_ENGINE_TELEMETRY');
      }
    }
  });

  it('is left at the vendors’ defaults when hostd has FLEETADLC_ENGINE_TELEMETRY=on', () => {
    process.env.FLEETADLC_ENGINE_TELEMETRY = 'on';
    for (const env of [hostBaseEnv(), containerBaseEnv()]) {
      for (const key of Object.keys(TELEMETRY_OPT_OUTS)) expect(env).not.toHaveProperty(key);
      // What tells the codex engine to leave its own switches alone.
      expect(env.FLEETADLC_ENGINE_TELEMETRY).toBe('on');
    }
  });

  it('reaches a session built the way hostd builds one', () => {
    delete process.env.FLEETADLC_ENGINE_TELEMETRY;
    const minted = { FLEETADLC_TASK_ID: 'task-1', FLEETADLC_REPO_HOME: '/work/slot/home' };
    for (const base of [hostBaseEnv(), containerBaseEnv()]) {
      expect(withRepoHome(base, minted)).toMatchObject(TELEMETRY_OPT_OUTS);
    }
  });
});

describe('a session on a host behind the egress proxy', () => {
  it('gets the proxy, because it starts under env -i and inherits nothing', async () => {
    const { containerBaseEnv } = await import('./base-env.js');
    const before = process.env.FLEETADLC_BOT_EGRESS_PROXY;
    process.env.FLEETADLC_BOT_EGRESS_PROXY = 'http://host.docker.internal:3128';
    try {
      const env = containerBaseEnv();
      expect(env.HTTPS_PROXY).toBe('http://host.docker.internal:3128');
      expect(env.NODE_USE_ENV_PROXY).toBe('1');
      expect(env.NO_PROXY).toContain('host.docker.internal');
    } finally {
      if (before === undefined) delete process.env.FLEETADLC_BOT_EGRESS_PROXY;
      else process.env.FLEETADLC_BOT_EGRESS_PROXY = before;
    }
  });

  it('gets none of it where there is no proxy', async () => {
    const { containerBaseEnv } = await import('./base-env.js');
    const before = process.env.FLEETADLC_BOT_EGRESS_PROXY;
    delete process.env.FLEETADLC_BOT_EGRESS_PROXY;
    try {
      expect(Object.keys(containerBaseEnv()).some((name) => /proxy/i.test(name))).toBe(false);
    } finally {
      if (before !== undefined) process.env.FLEETADLC_BOT_EGRESS_PROXY = before;
    }
  });
});

describe('a repository’s own environment inside a bot', () => {
  it('gives the session its repository’s home, global installs and tools, with OpenADLC’s gh still first', async () => {
    const { containerBaseEnv, withRepoHome } = await import('./base-env.js');
    const env = withRepoHome(containerBaseEnv(), { FLEETADLC_REPO_HOME: '/work/builder/homes/core', FLEETADLC_BOT: 'builder' });

    expect(env.HOME).toBe('/work/builder/homes/core');
    expect(env.NPM_CONFIG_PREFIX).toBe('/work/builder/homes/core/.local');
    expect(env.PNPM_HOME).toBe('/work/builder/homes/core/.local/share/pnpm');
    const path = env.PATH!.split(':');
    expect(path.slice(0, 3)).toEqual(['/opt/fleetadlc/bin', '/work/builder/homes/core/.local/bin', '/work/builder/homes/core/.local/share/pnpm']);
    // The image's engines are still found after them.
    expect(path).toContain('/home/bot/.local/bin');
    // Git keeps the image's settings, which live in the bot's own home.
    expect(env.GIT_CONFIG_GLOBAL).toBe('/home/bot/.gitconfig');
    expect(env.FLEETADLC_BOT).toBe('builder');
  });

  it('keeps two repositories of one bot apart', async () => {
    const { containerBaseEnv, withRepoHome } = await import('./base-env.js');
    const core = withRepoHome(containerBaseEnv(), { FLEETADLC_REPO_HOME: '/work/builder/homes/core' });
    const web = withRepoHome(containerBaseEnv(), { FLEETADLC_REPO_HOME: '/work/builder/homes/web' });
    expect(core.HOME).not.toBe(web.HOME);
    expect(core.NPM_CONFIG_PREFIX).not.toBe(web.NPM_CONFIG_PREFIX);
  });

  it('changes nothing where no repository home is named', async () => {
    const { containerBaseEnv, withRepoHome } = await import('./base-env.js');
    expect(withRepoHome(containerBaseEnv(), { FLEETADLC_BOT: 'qa' })).toEqual({ ...containerBaseEnv(), FLEETADLC_BOT: 'qa' });
  });

  it('shares npm’s cache, and reads pnpm’s store only from the read-only one hostd filled, never from the cache', async () => {
    // pnpm trusts its own index for a package it holds, so a store any task in
    // the repository could write was one it could plant code in for the next.
    const { containerBaseEnv, withRepoHome } = await import('./base-env.js');
    const env = withRepoHome(containerBaseEnv(), {
      FLEETADLC_REPO_HOME: '/srv/work/slots/t1/home',
      FLEETADLC_CACHE_DIR: '/cache',
      FLEETADLC_PNPM_STORE: '/pnpm-store',
    });

    expect(env.npm_config_cache).toBe('/cache/npm');
    expect(env.PNPM_STORE_DIR).toBe('/pnpm-store');
    expect(env.npm_config_store_dir).toBe('/pnpm-store');
    expect(env.npm_config_side_effects_cache).toBe('false');
    expect(env.NPM_CONFIG_PREFIX).toBe('/srv/work/slots/t1/home/.local');
    expect(env).not.toHaveProperty('XDG_CACHE_HOME');
  });

  it('gives a task a pnpm store of its own, in its home, when hostd filled none for it', async () => {
    const { containerBaseEnv, withRepoHome } = await import('./base-env.js');
    const env = withRepoHome(containerBaseEnv(), { FLEETADLC_REPO_HOME: '/srv/work/slots/t1/home', FLEETADLC_CACHE_DIR: '/cache' });

    expect(env.npm_config_cache).toBe('/cache/npm');
    expect(env.PNPM_STORE_DIR).toBe('/srv/work/slots/t1/home/.pnpm-store');
    expect(env.npm_config_store_dir).toBe('/srv/work/slots/t1/home/.pnpm-store');
    expect(env).not.toHaveProperty('npm_config_side_effects_cache');
    for (const value of Object.values(env)) expect(value).not.toContain('/cache/pnpm-store');
  });

  it('names each repository’s folder safely, and a task on none its own', async () => {
    const { repoHomeKey } = await import('./base-env.js');
    expect(repoHomeKey('FleetADLC-Testbed')).toBe('fleetadlc-testbed');
    expect(repoHomeKey('../../etc')).toBe('etc');
    expect(repoHomeKey(null)).toBe('_no-repository');
  });

  it('keys a repository by its full name, so two owners’ repositories of one name never share a cache', async () => {
    const { repoKeyOf } = await import('./base-env.js');
    expect(repoKeyOf('Acme/Widgets')).toBe('acme__widgets');
    expect(repoKeyOf('other/widgets')).not.toBe(repoKeyOf('acme/widgets'));
    expect(repoKeyOf(null)).toBeNull();
  });
});

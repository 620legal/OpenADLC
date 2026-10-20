import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadHostdConfig, loginRootFromEnv } from './config.js';

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

describe('where subscription logins live', () => {
  it('is under the install’s own home unless told otherwise', () => {
    delete process.env.OPENADLC_LOGIN_ROOT;
    process.env.OPENADLC_HOME = '/srv/openadlc-home';

    expect(loadHostdConfig().loginRoot).toBe(join('/srv/openadlc-home', 'logins'));
  });

  it('takes OPENADLC_LOGIN_ROOT, and the session environment reads the same answer', () => {
    process.env.OPENADLC_LOGIN_ROOT = '/var/lib/openadlc/logins';

    expect(loadHostdConfig().loginRoot).toBe('/var/lib/openadlc/logins');
    expect(loginRootFromEnv()).toBe(loadHostdConfig().loginRoot);
  });

  it('is absolute even when it was given relative, because it becomes a bind mount', () => {
    // `docker run -v logins/<id>:/openadlc/login` names a volume, not this path.
    process.env.OPENADLC_LOGIN_ROOT = 'relative/logins';

    expect(isAbsolute(loadHostdConfig().loginRoot)).toBe(true);
  });
});

describe('the names an install gives its bots', () => {
  it('keeps the default install’s names when none is set', () => {
    delete process.env.OPENADLC_BOT_PREFIX;
    delete process.env.OPENADLC_INSTALL_ID;

    expect(loadHostdConfig()).toMatchObject({ botPrefix: null, installId: null });
  });

  it('takes another install’s prefix and id, and refuses one Docker could not name a container after', () => {
    process.env.OPENADLC_BOT_PREFIX = 'openadlc-compose-bot-';
    process.env.OPENADLC_INSTALL_ID = 'compose-openadlc';
    expect(loadHostdConfig()).toMatchObject({ botPrefix: 'openadlc-compose-bot-', installId: 'compose-openadlc' });

    process.env.OPENADLC_BOT_PREFIX = 'OpenADLC Bots/';
    expect(() => loadHostdConfig()).toThrow('OPENADLC_BOT_PREFIX must be lowercase letters');
  });

  it('refuses a prefix without an install id, or an id without a prefix', () => {
    process.env.OPENADLC_BOT_PREFIX = 'openadlc-compose-bot-';
    delete process.env.OPENADLC_INSTALL_ID;
    expect(() => loadHostdConfig()).toThrow('OPENADLC_BOT_PREFIX is set and OPENADLC_INSTALL_ID is not');

    delete process.env.OPENADLC_BOT_PREFIX;
    process.env.OPENADLC_INSTALL_ID = 'compose-openadlc';
    expect(() => loadHostdConfig()).toThrow('OPENADLC_INSTALL_ID is set and OPENADLC_BOT_PREFIX is not');

    delete process.env.OPENADLC_INSTALL_ID;
  });
});

describe('the driver hostd runs tasks under', () => {
  it('is local when nothing says, and docker or local whatever the case and spacing', () => {
    delete process.env.OPENADLC_HOSTD_DRIVER;
    expect(loadHostdConfig().driver).toBe('local');

    for (const [value, driver] of [
      ['docker', 'docker'],
      ['Docker', 'docker'],
      ['docker ', 'docker'],
      [' LOCAL', 'local'],
    ]) {
      process.env.OPENADLC_HOSTD_DRIVER = value;
      expect(loadHostdConfig().driver).toBe(driver);
    }
  });

  it('refuses anything else, rather than running sessions on the host with no isolation', () => {
    // A typo used to select the local driver, without a word.
    process.env.OPENADLC_HOSTD_DRIVER = 'dokcer';
    expect(() => loadHostdConfig()).toThrow('OPENADLC_HOSTD_DRIVER is "dokcer"; it must be "docker" or "local"');
  });
});

describe('the private package registry', () => {
  it('is none when OPENADLC_REGISTRY_HOST is unset, empty or blank, and the host when it names one', () => {
    // The cloud host writes the variable empty when the module names no
    // registry, and that read as a registry with no token stored.
    delete process.env.OPENADLC_REGISTRY_HOST;
    expect(loadHostdConfig().registryHost).toBeNull();
    for (const value of ['', '   ']) {
      process.env.OPENADLC_REGISTRY_HOST = value;
      expect(loadHostdConfig().registryHost).toBeNull();
    }
    process.env.OPENADLC_REGISTRY_HOST = ' npm.internal.example ';
    expect(loadHostdConfig().registryHost).toBe('npm.internal.example');
  });
});

describe('how long make ci and make setup may run', () => {
  it('is an hour and half an hour when nothing says, and what the install says when it does', () => {
    delete process.env.OPENADLC_LOCAL_CI_TIMEOUT_MINUTES;
    delete process.env.OPENADLC_SETUP_TIMEOUT_MINUTES;
    expect(loadHostdConfig()).toMatchObject({ localCiTimeoutMinutes: 60, setupTimeoutMinutes: 30 });

    process.env.OPENADLC_LOCAL_CI_TIMEOUT_MINUTES = '90';
    process.env.OPENADLC_SETUP_TIMEOUT_MINUTES = '10';
    expect(loadHostdConfig()).toMatchObject({ localCiTimeoutMinutes: 90, setupTimeoutMinutes: 10 });
  });
});

describe('the install’s prices', () => {
  it('are read once from OPENADLC_CONFIG_ROOT, and a bad price stops hostd naming the file and the model', () => {
    const root = mkdtempSync(join(tmpdir(), 'openadlc-hostd-config-'));
    try {
      process.env.OPENADLC_CONFIG_ROOT = root;
      expect(loadHostdConfig().modelPrices).toEqual({});

      writeFileSync(join(root, 'models.yaml'), 'models:\n  gpt-5-codex:\n    inPerMtok: 250\n    outPerMtok: 10\n');
      expect(loadHostdConfig().modelPrices).toEqual({ 'gpt-5-codex': { inPerMtok: 250, outPerMtok: 10 } });

      for (const price of ['-1', '.nan', '.inf']) {
        writeFileSync(join(root, 'models.yaml'), `models:\n  gpt-5-codex:\n    inPerMtok: ${price}\n    outPerMtok: 10\n`);
        expect(() => loadHostdConfig(), price).toThrow(`${join(root, 'models.yaml')}: gpt-5-codex's inPerMtok`);
      }
      writeFileSync(join(root, 'models.yaml'), 'models:\n  gpt-5-codex:\n    inPerMtok: 1\n');
      expect(() => loadHostdConfig()).toThrow(/gpt-5-codex's outPerMtok/);
      writeFileSync(join(root, 'models.yaml'), 'models:\n  - name: resnet50\n');
      expect(() => loadHostdConfig()).toThrow(/has no `models:` map/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

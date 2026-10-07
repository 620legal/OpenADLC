import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYamlFile, reviewRulesSchema } from '@fleetadlc/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REVIEW, eventRetentionDaysFrom, identityModeFrom, loadBridgeConfig } from './config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const saved = process.env.FLEETADLC_IDENTITY_MODE;
const savedConfigRoot = process.env.FLEETADLC_CONFIG_ROOT;
const savedService = process.env.K_SERVICE;

afterEach(() => {
  if (saved === undefined) delete process.env.FLEETADLC_IDENTITY_MODE;
  else process.env.FLEETADLC_IDENTITY_MODE = saved;
  if (savedConfigRoot === undefined) delete process.env.FLEETADLC_CONFIG_ROOT;
  else process.env.FLEETADLC_CONFIG_ROOT = savedConfigRoot;
  if (savedService === undefined) delete process.env.K_SERVICE;
  else process.env.K_SERVICE = savedService;
});

describe('the review rules with no config/review.yaml', () => {
  const shipped = () => reviewRulesSchema.parse(parseYamlFile(join(ROOT, 'config', 'review.yaml')));

  it('are the rules the shipped config/review.yaml holds', () => {
    // The built-in copy drifted from the file: it left infra/ out of the SRE's
    // trigger and packages/github/ out of the security seat's, so an install
    // without review.yaml reviewed those changes with fewer lenses.
    expect(shipped()).toEqual(DEFAULT_REVIEW);
  });

  it('are what loadBridgeConfig reads when the config directory has no review.yaml', () => {
    const empty = mkdtempSync(join(tmpdir(), 'fleetadlc-config-'));
    try {
      process.env.FLEETADLC_CONFIG_ROOT = empty;
      const review = loadBridgeConfig().review;
      expect(review).toEqual(shipped());
      const sre = review.reviewers.find((entry) => entry.seat === 'sre');
      expect(sre?.trigger === 'always' ? [] : sre?.trigger.paths).toContain('infra/');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('FLEETADLC_IDENTITY_MODE', () => {
  it('is iap or local, and local when unset', () => {
    expect(identityModeFrom('iap')).toBe('iap');
    expect(identityModeFrom('local')).toBe('local');
    expect(identityModeFrom(undefined)).toBe('local');
    expect(identityModeFrom('')).toBe('local');
  });

  it('stops the bridge at start for anything else, rather than reading it as local and trusting a header', () => {
    for (const value of ['IAP', 'iap ', 'Local', 'google', 'true']) {
      expect(() => identityModeFrom(value), value).toThrow(/FLEETADLC_IDENTITY_MODE is .* it must be iap/);
    }
    // Through the config the bridge starts from: main() reports the error and exits 1.
    process.env.FLEETADLC_IDENTITY_MODE = 'IAP';
    expect(() => loadBridgeConfig()).toThrow(/must be iap/);
  });

  it('refuses local on Cloud Run, set or unset, where anyone reaching the bridge would be an admin', () => {
    process.env.K_SERVICE = 'fleetadlc-bridge';
    for (const value of ['local', undefined]) {
      if (value === undefined) delete process.env.FLEETADLC_IDENTITY_MODE;
      else process.env.FLEETADLC_IDENTITY_MODE = value;
      expect(() => loadBridgeConfig(), String(value)).toThrow(/FLEETADLC_IDENTITY_MODE=iap and FLEETADLC_IAP_AUDIENCE/);
    }
    process.env.FLEETADLC_IDENTITY_MODE = 'iap';
    expect(loadBridgeConfig().identityMode).toBe('iap');
  });

  it('starts local, set or unset, off Cloud Run', () => {
    delete process.env.K_SERVICE;
    for (const value of ['local', undefined]) {
      if (value === undefined) delete process.env.FLEETADLC_IDENTITY_MODE;
      else process.env.FLEETADLC_IDENTITY_MODE = value;
      expect(loadBridgeConfig().identityMode, String(value)).toBe('local');
    }
  });

  it('is set only to a value the bridge accepts, by the cloud module and the local stack', () => {
    const tf = readFileSync(join(ROOT, 'infra', 'gcp', 'main.tf'), 'utf8');
    const set = /name\s*=\s*"FLEETADLC_IDENTITY_MODE"\s*\n\s*value\s*=\s*(.+)/.exec(tf)?.[1]?.trim();
    expect(set).toBe('"iap"');
    // The local stack leaves it unset, which is `local`.
    const compose = readFileSync(join(ROOT, 'infra', 'local', 'docker-compose.yml'), 'utf8');
    for (const match of compose.matchAll(/FLEETADLC_IDENTITY_MODE\s*[:=]\s*["']?([^"'\s]*)/g)) {
      expect(() => identityModeFrom(match[1])).not.toThrow();
    }
  });
});

describe('FLEETADLC_EVENT_RETENTION_DAYS', () => {
  it('is 30 days when unset, and 0 keeps GitHub deliveries for good', () => {
    expect(eventRetentionDaysFrom(undefined)).toBe(30);
    expect(eventRetentionDaysFrom('')).toBe(30);
    expect(eventRetentionDaysFrom('0')).toBe(0);
    expect(eventRetentionDaysFrom('90')).toBe(90);
  });

  it('stops the bridge at start for a value that is not a whole number of days, naming the variable and the value', () => {
    for (const value of ['-1', '30d', '1.5', 'thirty']) {
      expect(() => eventRetentionDaysFrom(value), value).toThrow(`FLEETADLC_EVENT_RETENTION_DAYS is ${JSON.stringify(value)}`);
    }
    vi.stubEnv('FLEETADLC_EVENT_RETENTION_DAYS', '-1');
    try {
      expect(() => loadBridgeConfig()).toThrow(/FLEETADLC_EVENT_RETENTION_DAYS is "-1"; it must be a whole number of days/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('the console address links are made from', () => {
  it('follows the console’s port when no address is set, and an address set wins', () => {
    vi.stubEnv('FLEETADLC_CONSOLE_URL', '');
    vi.stubEnv('FLEETADLC_CONSOLE_PORT', '47400');
    try {
      expect(loadBridgeConfig().consoleUrl).toBe('http://127.0.0.1:47400');
      vi.stubEnv('FLEETADLC_CONSOLE_URL', 'https://fleetadlc.example.com');
      expect(loadBridgeConfig().consoleUrl).toBe('https://fleetadlc.example.com');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('the install’s models.yaml', () => {
  it('stops the bridge at start when a price is negative, naming the file and the model', () => {
    // config/models.example.yaml says a malformed file stops the bridge, and
    // nothing in the bridge read it.
    const root = mkdtempSync(join(tmpdir(), 'fleetadlc-bridge-config-'));
    try {
      writeFileSync(join(root, 'models.yaml'), 'models:\n  gpt-5-codex:\n    inPerMtok: -400000\n    outPerMtok: 10\n');
      vi.stubEnv('FLEETADLC_CONFIG_ROOT', root);
      expect(() => loadBridgeConfig()).toThrow(join(root, 'models.yaml'));
      expect(() => loadBridgeConfig()).toThrow(/gpt-5-codex's inPerMtok/);

      writeFileSync(join(root, 'models.yaml'), 'models:\n  gpt-5-codex:\n    inPerMtok: 250\n    outPerMtok: 10\n');
      expect(() => loadBridgeConfig()).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a key config/ does not read', () => {
  it('stops the bridge at start, naming the file and the key', () => {
    // A misspelt cap fell back to the default $1500, and a reviewer's
    // `blocked: true` left it advisory, with nothing said either time.
    const root = mkdtempSync(join(tmpdir(), 'fleetadlc-bridge-config-'));
    try {
      vi.stubEnv('FLEETADLC_CONFIG_ROOT', root);
      writeFileSync(join(root, 'costs.yaml'), 'monthlyCapUSD: 100\n');
      expect(() => loadBridgeConfig()).toThrow(`${join(root, 'costs.yaml')}: monthlyCapUSD is not a setting OpenADLC reads`);

      writeFileSync(join(root, 'costs.yaml'), 'monthlyCapUsd: 100\n');
      writeFileSync(join(root, 'review.yaml'), 'reviewers:\n  - seat: lead-reviewer\n    lens: lead\n    lead: true\n  - seat: security-reviewer\n    lens: security\n    blocked: true\n');
      expect(() => loadBridgeConfig()).toThrow(`${join(root, 'review.yaml')}: reviewers.1.blocked is not a setting OpenADLC reads`);

      writeFileSync(join(root, 'review.yaml'), readFileSync(join(ROOT, 'config', 'review.yaml'), 'utf8'));
      expect(loadBridgeConfig().costs.monthlyCapUsd).toBe(100);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

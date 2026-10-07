import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AppApi } from '@fleetadlc/github';
import { AppGate } from './app-gate.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = { clientId: 'Iv1.test', privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString() };

function fakeGitHub(permissions: Record<string, string>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const api: AppApi = {
    async request<T>(method: string, path: string, _token: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      if (path === '/app') return { id: 42, slug: 'fleetadlc-exampleco', permissions } as T;
      if (path.endsWith('/installation')) return { id: 7 } as T;
      if (path.endsWith('/access_tokens')) return { token: 'ghs_installation' } as T;
      if (path.includes('/check-runs?')) {
        return {
          check_runs: [
            { status: 'completed', conclusion: 'success', output: { title: 'forged' }, app: { id: 99 } },
            { status: 'in_progress', conclusion: null, output: { title: 'waiting on lead-reviewer' }, app: { id: 42 } },
          ],
        } as T;
      }
      return {} as T;
    },
  };
  return { api, calls };
}

describe('review-gate from the app', () => {
  it('is published as the app’s check run when the app holds Checks: write', async () => {
    const github = fakeGitHub({ checks: 'write' });
    const gate = new AppGate({ credentials: async () => credentials, api: github.api });
    expect(await gate.appId()).toBe(42);
    expect(await gate.publish('exampleco/api', 'abc1234', 'success', 'every review is in')).toBe(true);
    expect(github.calls.find((call) => call.method === 'POST' && call.path.endsWith('/check-runs'))?.body).toEqual({
      name: 'review-gate',
      head_sha: 'abc1234',
      status: 'completed',
      conclusion: 'success',
      output: { title: 'every review is in', summary: 'every review is in' },
    });
  });

  it('reads back only its own run, never one another app or token published under the same name', async () => {
    const gate = new AppGate({ credentials: async () => credentials, api: fakeGitHub({ checks: 'write' }).api });
    expect(await gate.standing('exampleco/api', 'abc1234')).toEqual({ state: 'pending', description: 'waiting on lead-reviewer' });
  });

  it('declines, so the status is all there is, when the app lacks the permission or its key', async () => {
    const lacking = fakeGitHub({ statuses: 'write' });
    const gate = new AppGate({ credentials: async () => credentials, api: lacking.api });
    expect(await gate.publish('exampleco/api', 'abc1234', 'pending', 'waiting')).toBe(false);
    expect(lacking.calls.some((call) => call.path.endsWith('/check-runs'))).toBe(false);
    expect(await new AppGate({ credentials: async () => null, api: lacking.api }).appId()).toBeNull();
  });
});

describe('the app’s own login', () => {
  it('is read from GET /app whether or not the app holds Checks: write', async () => {
    // Without Checks the gate is a status the app sets, and its creator is
    // this login; the merge line reads it by that name.
    const lacking = new AppGate({ credentials: async () => credentials, api: fakeGitHub({ statuses: 'write' }).api });
    expect(await lacking.appId()).toBeNull();
    expect(await lacking.botLogin()).toBe('fleetadlc-exampleco[bot]');

    const holding = new AppGate({ credentials: async () => credentials, api: fakeGitHub({ checks: 'write' }).api });
    expect(await holding.botLogin()).toBe('fleetadlc-exampleco[bot]');
  });

  it('asks GitHub once for both, while what it said is believed', async () => {
    const github = fakeGitHub({ checks: 'write' });
    const gate = new AppGate({ credentials: async () => credentials, api: github.api });
    await gate.appId();
    await gate.botLogin();
    expect(github.calls.filter((call) => call.path === '/app')).toHaveLength(1);
  });

  it('is nothing without the app’s key', async () => {
    expect(await new AppGate({ credentials: async () => null, api: fakeGitHub({}).api }).botLogin()).toBeNull();
  });
});

describe('the review-gate status from the app', () => {
  it('is set with the app’s installation token, whatever the automation account may do', async () => {
    const github = fakeGitHub({ statuses: 'write' });
    const gate = new AppGate({ credentials: async () => credentials, api: github.api });
    expect(await gate.publishStatus('exampleco/api', 'abc1234', 'pending', 'waiting on lead-reviewer')).toBe(true);
    expect(github.calls.find((call) => call.method === 'POST' && call.path === '/repos/exampleco/api/statuses/abc1234')?.body).toEqual({
      state: 'pending',
      context: 'review-gate',
      description: 'waiting on lead-reviewer',
    });
  });

  it('declines without the app’s key, so the automation account is tried', async () => {
    const gate = new AppGate({ credentials: async () => null, api: fakeGitHub({}).api });
    expect(await gate.publishStatus('exampleco/api', 'abc1234', 'pending', 'waiting')).toBe(false);
  });
});

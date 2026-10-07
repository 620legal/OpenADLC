// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepoSetupView, type RepoPlan } from './repo-setup-step';

const PLAN_LIMIT =
  'GitHub protects a private repository’s environments only on a paid plan, and holds a required reviewer on one only on GitHub Enterprise.';

function plan(repository: string, unsupported: string[]): RepoPlan {
  return {
    repository,
    labels: [],
    rules: unsupported.map((name) => ({ name, state: 'unsupported' as const, detail: PLAN_LIMIT })),
    templates: [],
    labelChanges: 0,
    ruleChanges: 0,
    canApply: true,
    detail: '',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('the limits a mixed install shares', () => {
  it('keys two groups that say the same sentence apart', async () => {
    // One repository has the sentence of both environments, the other of one:
    // two groups, one sentence. Keyed by the sentence, React reused one
    // group's open list for the other.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <RepoSetupView
          plans={[
            plan('exampleco/one', ['environment testing', 'environment production']),
            plan('exampleco/two', ['environment production']),
          ]}
          runs={{}}
          running={false}
          busy={null}
          done={{}}
          error={null}
          onSetUpAll={() => undefined}
          onApply={() => undefined}
          onApprovers={async () => undefined}
        />,
      );
    });

    expect(host.textContent?.split(PLAN_LIMIT).length).toBe(3);
    expect(errors.mock.calls.map((call) => call.join(' ')).filter((line) => line.includes('same key'))).toEqual([]);
    act(() => root.unmount());
  });
});

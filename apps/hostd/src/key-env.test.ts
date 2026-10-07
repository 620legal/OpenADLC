import { describe, expect, it } from 'vitest';
import { keyEnv } from './key-env.js';

/**
 * Codex 0.155's `exec` ignores OPENAI_API_KEY — it sent no credential and
 * OpenAI answered 401 "Missing bearer or basic authentication in header" — and
 * reads CODEX_API_KEY. Reviewers running on an OpenAI key failed this way.
 */
describe('the variables a key goes into', () => {
  it('gives an OpenAI key to Codex under CODEX_API_KEY as well', () => {
    expect(keyEnv('OPENAI_API_KEY', 'sk-proj-x')).toEqual({ OPENAI_API_KEY: 'sk-proj-x', CODEX_API_KEY: 'sk-proj-x' });
  });

  it('leaves every other key under its own name', () => {
    expect(keyEnv('ANTHROPIC_API_KEY', 'sk-ant-x')).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-x' });
    expect(keyEnv('XAI_API_KEY', 'xai-x')).toEqual({ XAI_API_KEY: 'xai-x' });
  });
});

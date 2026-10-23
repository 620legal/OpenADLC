import { describe, expect, it } from 'vitest';
import { whatNext } from './intake-dialog';

describe('what the New request dialog says comes next', () => {
  it('says intake is starting when the bridge answered before its task existed', () => {
    // The bridge answers once the request is saved; "on it" claimed a task
    // that might not exist yet.
    expect(whatNext({ queued: false, position: null, starting: true })).toBe('Intake is starting on it');
  });

  it('says intake is on it when an older bridge answered with the task', () => {
    expect(whatNext({ queued: false, position: null })).toBe('Intake is on it');
  });

  it('gives its place in line, and why it waits while work is paused', () => {
    expect(whatNext({ queued: true, position: 2 })).toBe('Queued (#2)');
    expect(whatNext({ queued: true, position: 2, paused: 'work is paused' })).toBe('Queued (#2): work is paused, so it starts when work resumes');
  });
});

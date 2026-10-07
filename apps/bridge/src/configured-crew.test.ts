import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configuredFirstOfRole, configuredFor, configuredSeats } from './configured-crew.js';

describe('what the configuration gives each bot', () => {
  it('reads the engine and model config/bots.yaml sets, for the console to propose from', () => {
    const root = join(__dirname, '..', '..', '..', 'config');
    const crew = new Map(configuredSeats(root).map((seat) => [seat.slot, seat]));
    // By seat: a connected bot goes by its handle, and the file names seats.
    expect(crew.get('second-reviewer')?.engine).toBe('grok');
    expect(crew.get('builder')?.engine).toBe('claude');
    expect(crew.get('automation')?.engine).toBe('none');
    expect(crew.has('atlas')).toBe(false);
    // Intake clarifies everything with the person and reads their screenshots:
    // a fresh install proposes a model that can, not the one that only routed.
    expect(crew.get('intake')?.model).toBe('newest:sonnet');
  });

  it('is empty, not an error, when the file is missing or malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-configured-'));
    try {
      expect(configuredSeats(undefined)).toEqual([]);
      expect(configuredSeats(dir)).toEqual([]);
      writeFileSync(join(dir, 'bots.yaml'), 'bots: [not, valid');
      expect(configuredSeats(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('what a seat the file does not name falls back to', () => {
  const root = join(__dirname, '..', '..', '..', 'config');

  it('is its role’s first seat: builder-2, added from settings, is configured as builder is', () => {
    expect(configuredFor(root, { slot: 'builder-2', role: 'implement' })).toMatchObject({ slot: 'builder', engine: 'claude' });
    expect(configuredFirstOfRole(root, 'implement')?.slot).toBe('builder');
  });

  it('is the seat’s own entry when the file names it', () => {
    expect(configuredFor(root, { slot: 'second-reviewer', role: 'review_second' })?.engine).toBe('grok');
  });

  it('is nothing for a role the file gives no seat', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-configured-'));
    try {
      writeFileSync(join(dir, 'bots.yaml'), 'bots:\n  - { slot: qa, displayName: QA, role: qa, engine: claude, model: m }\n');
      expect(configuredFor(dir, { slot: 'builder-2', role: 'implement' })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

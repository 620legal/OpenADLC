import { describe, expect, it } from 'vitest';
import { REPO_DEFAULTS, repoConfigSchema } from './config.js';
import {
  UNTOUCHABLE_STAGES,
  hasIgnoreLabel,
  IGNORE_LABEL,
  BACKWARD,
  isBackwardMove,
  isForwardMove,
  isStageLabel,
  previousStage,
  labelStep,
  normaliseStageMode,
  normaliseStageModes,
  stageFromLabels,
  STAGE_LABELS,
} from './stages.js';
import { STAGE_MODES } from './types.js';

describe('stages are labels', () => {
  it('reads the stage off the labels', () => {
    expect(stageFromLabels(['priority:p1', 'adlc:build', 'do:ai'])).toBe('build');
  });

  it('has no stage when no stage label is present', () => {
    expect(stageFromLabels(['priority:p1'])).toBeNull();
  });

  it('maps every stage to exactly one label', () => {
    const labels = Object.values(STAGE_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('a card only moves forward', () => {
  it('allows the moves a stage owner makes', () => {
    expect(isForwardMove('intake', 'build')).toBe(true);
    expect(isForwardMove('intake', 'spec')).toBe(true);
    expect(isForwardMove('spec', 'build')).toBe(true);
    expect(isForwardMove('build', 'review')).toBe(true);
    expect(isForwardMove('review', 'merged')).toBe(true);
    expect(isForwardMove('merged', 'done')).toBe(true);
    // Merging is shipping where the repository deploys nothing.
    expect(isForwardMove('review', 'done')).toBe(true);
  });

  it('refuses to move a card backwards', () => {
    expect(isForwardMove('review', 'build')).toBe(false);
    expect(isForwardMove('done', 'merged')).toBe(false);
    expect(isForwardMove('build', 'intake')).toBe(false);
  });

  it('refuses to skip a stage', () => {
    expect(isForwardMove('build', 'merged')).toBe(false);
    expect(isForwardMove('intake', 'review')).toBe(false);
  });
});

describe('assist, which is no longer a stage mode', () => {
  it('is not offered, and reads as autonomous wherever it is still written', () => {
    expect(STAGE_MODES).not.toContain('assist');
    expect(normaliseStageMode('assist')).toBe('autonomous');
    expect(normaliseStageMode('untouched')).toBe('untouched');
    expect(normaliseStageModes({ merged: 'assist', spec: 'conditional' })).toEqual({ merged: 'autonomous', spec: 'conditional' });
  });

  it('reads untouched as autonomous on a stage that cannot be untouched, as a stored row or a backup may still have it', () => {
    expect(UNTOUCHABLE_STAGES).toEqual(['intake', 'spec']);
    expect(normaliseStageModes({ intake: 'untouched', spec: 'untouched', build: 'untouched', review: 'untouched', merged: 'untouched', done: 'untouched' })).toEqual({
      intake: 'untouched',
      spec: 'untouched',
      build: 'autonomous',
      review: 'autonomous',
      merged: 'autonomous',
      done: 'autonomous',
    });
  });

  it('does not fail an older config/repos.yaml that has it, and is no longer anyone’s default', () => {
    const base = { name: 'api', fullName: 'acme/api', owner: 'builder' };
    expect(repoConfigSchema.parse({ ...base, stageModes: { merged: 'assist' } }).stageModes).toEqual({ merged: 'autonomous' });
    expect(Object.values(REPO_DEFAULTS.stageModes)).not.toContain('assist');
    expect(() => repoConfigSchema.parse({ ...base, stageModes: { merged: 'sometimes' } })).toThrow();
  });
});

describe('labels named before the rename to FleetADLC', () => {
  it('reads a stage from the sdlc: label an issue still carries', () => {
    expect(stageFromLabels(['priority:p2', 'sdlc:review'])).toBe('review');
    expect(stageFromLabels(['sdlc:build', 'adlc:review'])).toBe('review');
    expect(isStageLabel('sdlc:done')).toBe(true);
    expect(isStageLabel('adlc:done')).toBe(true);
    expect(isStageLabel('area:docs')).toBe(false);
    // The prefix is not the test: adlc:ci shares it, and is no stage.
    expect(isStageLabel('adlc:ci')).toBe(false);
  });

  it('leaves an issue labelled with the old ignore label alone', () => {
    expect(hasIgnoreLabel(['fleet:ignore'])).toBe(true);
    expect(hasIgnoreLabel(['fleetadlc:ignore'])).toBe(true);
    expect(hasIgnoreLabel(['fleet:ignored', 'adlc:build'])).toBe(false);
    expect(hasIgnoreLabel(undefined)).toBe(false);
  });

  it('renames an old label in place rather than creating the new one beside it', () => {
    const wanted = { name: 'adlc:build', color: '0e8a16', description: 'Routable' };
    expect(labelStep(wanted, [{ name: 'sdlc:build', color: '0e8a16', description: 'Routable' }])).toEqual({
      action: 'update',
      from: 'sdlc:build',
      detail: 'renamed from sdlc:build; issues keep it',
    });
    expect(labelStep({ ...wanted, name: IGNORE_LABEL }, [{ name: 'fleet:ignore' }])).toMatchObject({
      action: 'update',
      from: 'fleet:ignore',
    });
  });

  it('writes a label that exists under its new name as it always did', () => {
    const wanted = { name: 'adlc:build', color: '0e8a16', description: 'Routable' };
    expect(labelStep(wanted, [])).toEqual({ action: 'create', detail: 'not there yet' });
    expect(labelStep(wanted, [{ ...wanted }, { name: 'sdlc:build' }])).toEqual({ action: 'unchanged', detail: '' });
    expect(labelStep(wanted, [{ ...wanted, color: 'ffffff' }])).toMatchObject({ action: 'update', from: 'adlc:build' });
    expect(labelStep({ name: 'area:docs', color: 'c5def5', description: '' }, [])).toMatchObject({ action: 'create' });
  });
});

describe('where a send-back goes', () => {
  const staffed = { intake: 'autonomous', spec: 'conditional', build: 'autonomous', review: 'autonomous', merged: 'autonomous' } as const;

  it('sends design back to intake, and review and ship back to build', () => {
    expect(previousStage('spec', [], staffed)).toEqual({ to: 'intake', staffed: true });
    expect(previousStage('review', [], staffed)).toEqual({ to: 'build', staffed: true });
    expect(previousStage('merged', [], staffed)).toEqual({ to: 'build', staffed: true });
    expect(previousStage('intake', [], staffed)).toBeNull();
    expect(previousStage('done', [], staffed)).toBeNull();
  });

  it('sends build back to design only when the issue had a design pass this time round', () => {
    const designed = [
      { from: null, to: 'intake' },
      { from: 'intake', to: 'spec' },
      { from: 'spec', to: 'build' },
    ] as const;
    expect(previousStage('build', designed, staffed)).toEqual({ to: 'spec', staffed: true });

    // Intake sent it straight to build: there is no design to go back to.
    const straight = [
      { from: null, to: 'intake' },
      { from: 'intake', to: 'build' },
    ] as const;
    expect(previousStage('build', straight, staffed)).toEqual({ to: 'intake', staffed: true });

    // A design pass before the last time it went back to intake is an earlier cycle's.
    const earlier = [...designed, { from: 'build', to: 'intake' }, { from: 'intake', to: 'build' }] as const;
    expect(previousStage('build', earlier, staffed)).toEqual({ to: 'intake', staffed: true });

    // Design itself sent it back to intake: that pass was the earlier cycle's too.
    const returned = [
      { from: null, to: 'intake' },
      { from: 'intake', to: 'spec' },
      { from: 'spec', to: 'intake' },
      { from: 'intake', to: 'build' },
    ] as const;
    expect(previousStage('build', returned, staffed)).toEqual({ to: 'intake', staffed: true });

    // A review round in between does not lose the design.
    const reviewed = [...designed, { from: 'build', to: 'review' }, { from: 'review', to: 'build' }] as const;
    expect(previousStage('build', reviewed, staffed)).toEqual({ to: 'spec', staffed: true });
  });

  it('passes over a stage nobody staffs, walking back', () => {
    const designed = [{ from: 'intake', to: 'spec' }, { from: 'spec', to: 'build' }] as const;
    expect(previousStage('build', designed, { ...staffed, spec: 'untouched' })).toEqual({ to: 'intake', staffed: true });
  });

  it('passes over only an untouched intake or spec, the stages untouched means anything in', () => {
    // Build was skipped for Intake, though the dispatcher still staffs Build.
    expect(previousStage('review', [], { ...staffed, build: 'untouched' })).toEqual({ to: 'build', staffed: true });
    expect(previousStage('merged', [], { ...staffed, build: 'untouched' })).toEqual({ to: 'build', staffed: true });
  });

  it('goes to the stage directly before, for a person, when nothing on the way back is staffed', () => {
    expect(previousStage('spec', [], { ...staffed, intake: 'untouched' })).toEqual({ to: 'intake', staffed: false });
    const designed = [{ from: 'intake', to: 'spec' }, { from: 'spec', to: 'build' }] as const;
    expect(previousStage('build', designed, { ...staffed, intake: 'untouched', spec: 'untouched' })).toEqual({ to: 'spec', staffed: false });
  });

  it('tells a move back from a move on', () => {
    expect(isBackwardMove('review', 'build')).toBe(true);
    expect(isBackwardMove('build', 'intake')).toBe(true);
    expect(isBackwardMove('build', 'review')).toBe(false);
    expect(isBackwardMove('build', 'build')).toBe(false);
    expect(BACKWARD.build).toEqual(['spec', 'intake']);
  });
});

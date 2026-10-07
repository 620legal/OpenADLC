import { describe, expect, it } from 'vitest';
import { STAGE_COLUMN_TITLES, STAGE_KEYS, UNTOUCHABLE_STAGES as SHARED_UNTOUCHABLE } from '../../../../packages/shared/src/stages';
import { STAGE_MODES as SHARED_MODES } from '../../../../packages/shared/src/types';
import { modeIsSettable, modesFor, STAGE_MODES, STAGES, UNTOUCHABLE_STAGES } from './stages';

describe('the console’s copy of the stages', () => {
  it('names every stage the way the board does, in the board’s order', () => {
    expect(STAGES.map((stage) => stage.key)).toEqual([...STAGE_KEYS]);
    for (const stage of STAGES) expect(stage.title).toBe(STAGE_COLUMN_TITLES[stage.key]);
  });

  it('offers the modes the bridge accepts', () => {
    expect([...STAGE_MODES]).toEqual([...SHARED_MODES]);
  });

  it('calls them what a person would: a design pass, a build, shipping', () => {
    expect(STAGES.map((stage) => stage.title)).toEqual(['Intake', 'Design', 'Build', 'Review', 'Ship', 'Done']);
    for (const stage of STAGES) expect(stage.subtitle.length).toBeGreaterThan(0);
  });

  it('no longer has assist, which did what autonomous does', () => {
    expect(STAGE_MODES).not.toContain('assist');
  });

  it('offers conditional on Design alone, and no control for Done', () => {
    for (const { key } of STAGES) {
      expect(modesFor(key).includes('conditional')).toBe(key === 'spec');
    }
    expect(STAGES.filter(({ key }) => !modeIsSettable(key)).map(({ key }) => key)).toEqual(['done']);
  });

  it('offers untouched on Intake and Design alone, as the bridge accepts it', () => {
    expect([...UNTOUCHABLE_STAGES]).toEqual([...SHARED_UNTOUCHABLE]);
    for (const { key } of STAGES) {
      expect(modesFor(key).includes('untouched'), key).toBe(key === 'intake' || key === 'spec');
    }
  });
});

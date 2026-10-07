/**
 * Said once when intake stops trying an issue that stays in intake
 * (`StageHandoff.intakeGaveUp`); Needs you reads it (`attention.ts`). Its own
 * module, so neither of those has to import the other.
 */
export const INTAKE_STALLED = 'intake.stalled';

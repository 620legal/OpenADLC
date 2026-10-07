// The matching lives in @fleetadlc/shared (`path-overlap.ts`), so the
// dispatcher and the merge line's conflict round read one policy the same way.
export { overlapKind, pathsOverlap, policyPathMatches as pathMatches, type OverlapKind } from '@fleetadlc/shared';

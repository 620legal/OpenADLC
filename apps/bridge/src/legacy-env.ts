import { adoptLegacyEnv, legacyEnvNote } from '@openadlc/shared';

// First import of main.ts, so a FLEETADLC_* setting is adopted before any
// other module reads the environment. The rename to FleetADLC read no FLEET_*
// at all, and an install started with only its old names came up empty.
const note = legacyEnvNote(adoptLegacyEnv());
if (note) console.error(note);

#!/usr/bin/env node
// The command's name before the rename to OpenADLC. Muscle memory and scripts
// still type it, so it runs the same CLI — with one line saying what to type
// now, on stderr, where it cannot land in a pipe's output.
console.error('fleetadlc is now openadlc; this name still works, but switch when convenient (docs/upgrading-from-fleet.md#from-fleetadlc-to-openadlc)');
await import('./openadlc.mjs');

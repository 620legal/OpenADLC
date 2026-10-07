// Every unit test runs against an install home of its own, never the one on
// this machine. The secret store, install.json and the undo store all default
// to ~/.fleetadlc: on a machine with a real install, the bridge's webhook
// tests read its webhook secret from there and failed, and any test that
// wrote a secret would have written it into that install. A test that sets
// FLEETADLC_HOME itself still does; this is only the default.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEETADLC_HOME = mkdtempSync(join(tmpdir(), 'fleetadlc-test-home-'));

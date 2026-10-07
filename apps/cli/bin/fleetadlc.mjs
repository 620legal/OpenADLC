#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const compiled = join(here, '..', 'dist', 'main.js');

if (!existsSync(compiled)) {
  console.error('fleetadlc is not built yet. Run: pnpm build');
  process.exit(1);
}

await import(compiled);

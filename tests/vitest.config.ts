import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// See vitest.isolated-home.ts at the root: no test reads this machine's install.
export default defineConfig({ test: { setupFiles: [fileURLToPath(new URL('../vitest.isolated-home.ts', import.meta.url))] } });

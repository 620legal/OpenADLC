import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

// tsc compiles the tests into dist/ beside the code, and vitest 4 no longer
// leaves dist/ out by default: every test ran twice, the second time against
// a build that may be older than the source. setupFiles: see
// vitest.isolated-home.ts at the root.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, 'dist/**'], setupFiles: [fileURLToPath(new URL('../../vitest.isolated-home.ts', import.meta.url))] } });

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The app resolves `@/` through tsconfig paths, which vitest does not read, and
// leaves JSX to Next. Both are said here so a test can render a component.
//
// `.mts`, so Vite loads it as ESM: the package is not `"type": "module"` (that
// would change how Next and PostCSS read their own configs), and as `.ts` it
// went through Vite's deprecated CJS build, with a warning on every run.
export default defineConfig({
  test: { setupFiles: [fileURLToPath(new URL('../../vitest.isolated-home.ts', import.meta.url))] },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  oxc: { jsx: { runtime: 'automatic' } },
});

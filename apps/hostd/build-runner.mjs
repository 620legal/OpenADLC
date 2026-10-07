/**
 * Bundles the skill runner into one self-contained file.
 *
 * A task under the `docker` driver runs its skill inside the bot's container,
 * and the container has Node but not the platform's code. The two obvious
 * answers are both worse than this one: mounting the workspace gives every bot
 * read access to `config/`, because the runner resolves its imports through
 * pnpm's symlink farm at the repository root and there is no way to mount "just
 * the runner's dependencies"; and building the runner into the image
 * version-locks that image to the platform, so upgrading hostd means rebuilding
 * the image.
 *
 * One file, mounted read-only, is neither. The bot gets the runner and nothing
 * else, and because the mount is read live, a rebuilt bundle is picked up by the
 * next task without recreating a single container.
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(here, 'dist', 'skill-runner.js')],
  outfile: join(here, 'dist', 'skill-runner.bundle.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // A dependency in the graph calls `require` at run time. In an ESM bundle
  // that throws "Dynamic require of \"process\" is not supported", which looks
  // like a broken runner rather than a bundling detail.
  banner: {
    js: "import { createRequire as __fleetRequire } from 'node:module';\nconst require = __fleetRequire(import.meta.url);",
  },
});

console.log('[hostd] bundled dist/skill-runner.bundle.mjs');

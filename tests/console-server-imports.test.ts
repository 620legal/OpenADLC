import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A server component may render what a `'use client'` module exports, but it
 * may never call a function from one: Next replaces every export of such a
 * module with a client reference on the server, and calling it throws
 * "Attempted to call … from the server". Unit tests import the module directly
 * and `next build` does not render, so neither catches it; the settings page
 * shipped that way once and failed on every load.
 *
 * So every page and layout that is itself a server component is read, and any
 * lowercase name it imports from a client module — a function, not a
 * component — is a failure.
 */

const CONSOLE = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'console', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const isClient = (source: string): boolean => /^\s*['"]use client['"]/.test(source);

/**
 * The file an import names, from the file that imports it: `@/` is the
 * console's `src/`, and `./` or `../` is beside the importer. Only `@/` was
 * read once, and the root layout imports with relative paths, from a client
 * module among others, so it was never checked.
 */
function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join(CONSOLE, specifier.slice(2));
  else if (specifier.startsWith('./') || specifier.startsWith('../')) base = join(dirname(from), specifier);
  else return null;
  for (const candidate of [`${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not this one
    }
  }
  return null;
}

describe('server components and client modules', () => {
  it('calls no function exported from a client module', () => {
    const servers = files(join(CONSOLE, 'app')).filter(
      (path) => /\/(page|layout)\.tsx$/.test(path) && !isClient(readFileSync(path, 'utf8')),
    );
    expect(servers.length).toBeGreaterThan(0);

    const offences: string[] = [];
    for (const path of servers) {
      const source = readFileSync(path, 'utf8');
      // `import { a } from`, and `import X, { a } from`: X is a default
      // export, a component, and only the names in braces can be functions.
      for (const match of source.matchAll(/import\s+(type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g)) {
        if (match[1]) continue;
        const target = resolveImport(path, match[3] as string);
        if (!target || !isClient(readFileSync(target, 'utf8'))) continue;
        const names = (match[2] as string)
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name && !name.startsWith('type '))
          .map((name) => name.split(/\s+as\s+/)[0] as string)
          .filter((name) => /^[a-z]/.test(name));
        for (const name of names) offences.push(`${path.slice(CONSOLE.length + 1)} imports ${name} from ${match[3]}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('reads an import written relative to the importer', () => {
    // The root layout imports `RoleProvider` from `../components/app-header`,
    // a client module that also exports functions a server must not call.
    const layout = join(CONSOLE, 'app', 'layout.tsx');
    const target = resolveImport(layout, '../components/app-header');
    expect(target).toBe(join(CONSOLE, 'components', 'app-header.tsx'));
    expect(isClient(readFileSync(target as string, 'utf8'))).toBe(true);
  });
});

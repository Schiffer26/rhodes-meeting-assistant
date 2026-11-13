#!/usr/bin/env node
/**
 * Copy the SQL migrations into the build output.
 *
 * `tsc` compiles TypeScript and ignores .sql files, so without this step
 * `dist/db/migrations/` would be empty and a packaged build could not create its own
 * schema — a failure that only shows up on a machine that has never run the service
 * before. Runs after every successful build; the source files stay the single copy.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const from = path.join(serverRoot, 'src', 'db', 'migrations');
const to = path.join(serverRoot, 'dist', 'db', 'migrations');

if (!existsSync(from)) {
  console.error(`[copy-migrations] source directory missing: ${from}`);
  process.exit(1);
}

mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });

console.log(`[copy-migrations] ${from} -> ${to}`);

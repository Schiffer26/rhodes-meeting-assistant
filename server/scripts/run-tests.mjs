#!/usr/bin/env node
/**
 * Run the backend test suite.
 *
 * The test files are TypeScript, so the runner is `node --test` with `tsx` as the
 * loader (tsx is already a devDependency for `npm run dev`; no extra tooling). File
 * paths are resolved here rather than passed as a glob, because npm scripts run
 * through cmd.exe on Windows, where a glob would reach Node unexpanded.
 *
 * Extra arguments are forwarded, e.g. `npm test -- --test-name-pattern=health`.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const testDir = path.join(serverRoot, 'test');

const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => path.join(testDir, name));

if (files.length === 0) {
  console.error(`[run-tests] no *.test.ts files found in ${testDir}`);
  process.exit(1);
}

const forwarded = process.argv.slice(2);
const args = ['--import', 'tsx', '--test', ...(forwarded.length > 0 ? forwarded : []), ...files];

const child = spawn(process.execPath, args, { cwd: serverRoot, stdio: 'inherit' });

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[run-tests] terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(`[run-tests] failed to start the test runner: ${error.message}`);
  process.exit(1);
});

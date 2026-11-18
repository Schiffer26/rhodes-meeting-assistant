/**
 * Log capture without touching the process streams (QA correction).
 *
 * `captureLogs` used to monkey-patch `process.stdout.write`. When the test runner executes
 * a file in a child process it reads that child's TAP report from stdout, so the patch also
 * swallowed the runner's own `ok N - …` lines: passing tests disappeared from the report
 * and the tally came out short. The logger now exposes an injectable sink, and these tests
 * pin both halves of that contract — capture works, and the streams are left alone.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { currentLogSink, installLogSink, logger, setLogLevel } from '../src/logger.js';
import { captureLogs } from './helpers.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('captureLogs leaves the process streams untouched', async () => {
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;

  const logs = await captureLogs(() => {
    logger.info('sink.probe', { value: 1 });
    logger.warn('sink.probe_warning');
  });

  assert.equal(process.stdout.write, stdoutWrite, 'stdout.write must not be replaced');
  assert.equal(process.stderr.write, stderrWrite, 'stderr.write must not be replaced');

  const messages = logs
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { msg: string }).msg);
  assert.deepEqual(messages, ['sink.probe', 'sink.probe_warning']);
  assert.match(logs, /"value":1/);
});

test('the previous sink is restored, and captures nest', async () => {
  const outer: string[] = [];

  const restoreOuter = installLogSink((_level, line) => outer.push(line));
  try {
    logger.info('outer.before');
    const inner = await captureLogs(() => {
      logger.info('inner.only');
    });
    logger.info('outer.after');

    assert.deepEqual(
      outer.map((line) => (JSON.parse(line) as { msg: string }).msg),
      ['outer.before', 'outer.after'],
      'the nested capture must not leak into the outer sink',
    );
    assert.match(inner, /"msg":"inner.only"/);
    assert.ok(!inner.includes('outer.after'), 'the inner capture must not see later lines');
  } finally {
    restoreOuter();
  }

  // Restoring twice is harmless, and the default sink is back afterwards.
  restoreOuter();
  assert.equal(typeof currentLogSink(), 'function');
});

test('nothing is captured when no sink is installed, and the level filter still applies', async () => {
  // With the default sink in place the line goes to the streams; nothing is buffered.
  logger.info('this line is written normally');

  setLogLevel('warn');
  try {
    const atWarn = await captureLogs(() => {
      logger.debug('filtered.debug');
      logger.info('filtered.info');
      logger.warn('kept.warn');
    });
    assert.equal(atWarn.trim().split('\n').length, 1);
    assert.match(atWarn, /"msg":"kept\.warn"/);
  } finally {
    setLogLevel('info');
  }
});

/** Run the probe fixture and resolve with its two streams kept apart. */
function runLogProbe(): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join('test', 'fixtures', 'log-probe.ts')], {
    cwd: serverRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve({ stdout, stderr, code }));
  });
}

test('the default sink keeps info on stdout and warn/error on stderr', async () => {
  const { stdout, stderr, code } = await runLogProbe();
  assert.equal(code, 0);

  const outMessages = stdout
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { msg: string }).msg);
  const errMessages = stderr
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { msg: string }).msg);

  assert.deepEqual(outMessages, ['probe.info']);
  assert.deepEqual(errMessages, ['probe.warn', 'probe.error']);
  assert.ok(!stdout.includes('probe.debug'), 'debug is below the default threshold');
});
